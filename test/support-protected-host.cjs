const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const vscode = require('vscode');
const { revealFile } = require('../out/reveal.js');
const trace = [];
let currentExplorer;

/** Wait for the real backend and editor to publish a new support state. */
async function until(predicate, reason) {
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.fail(typeof reason === 'function' ? reason() : reason);
}

/** Keep rules and source changes inside the runner's disposable playground project. */
function support(rule) {
  const owner = '11111111-1111-1111-1111-111111111111';
  const attribute = '22222222-2222-2222-2222-222222222222';
  return `{6,0,1,${owner},0,${owner},"1","Vendor","Fixture",2,${rule},0,${owner},${owner},0,0,${attribute},${attribute},0,0,0,1,0,0,0,1,0,1,0,1,1,1,1}`;
}

/** ESKA opens supported sources through a readonly provider that session commands cannot unlock. */
exports.run = async function () {
  const fixture = JSON.parse(process.env.ESKA_HOST_FIXTURE);
  const rules = path.join(fixture.source, 'Ext/ParentConfigurations.bin');
  await fs.mkdir(path.dirname(rules), { recursive: true });
  await fs.writeFile(rules, support(0));
  const moduleUri = vscode.Uri.file(fixture.module);
  const original = await fs.readFile(fixture.module, 'utf8');
  const explorer = await vscode.extensions.all.find(extension => extension.packageJSON.name === 'eska-explorer').activate();
  currentExplorer = explorer;
  const notify = explorer.connection.notify.bind(explorer.connection);
  explorer.connection.notify = (...args) => {
    if (args[1] === 'workspace/didChangeFiles' && trace.length < 80) trace.push({ fileEvent: args[2] });
    notify(...args);
  };
  explorer.connection.onNotification((method, params) => {
    if (method === 'metadata/changed' && trace.length < 80) trace.push({ changed: params });
  });
  const request = explorer.connection.request.bind(explorer.connection);
  explorer.connection.request = async (...args) => {
    const result = await request(...args);
    if (args[1] === 'metadata/supportFiles' && trace.length < 80) trace.push({ support: result });
    return result;
  };
  const warn = explorer.output.warn.bind(explorer.output);
  explorer.output.warn = (...values) => { if (trace.length < 80) trace.push(values[0]); warn(...values); };
  const showError = explorer.showError.bind(explorer);
  explorer.showError = error => { if (trace.length < 80) trace.push({ code: error.code, domain: error.domain, details: error.details }); showError(error); };
  const resolveUri = explorer.support.resolveUri.bind(explorer.support);
  explorer.support.resolveUri = async (...args) => {
    const uri = await resolveUri(...args);
    if (trace.length < 80) trace.push({ source: path.basename(args[0]), scheme: uri.scheme });
    return uri;
  };
  await vscode.commands.executeCommand('eska.explorer.connect');
  /** Report backend policy when the fixture cannot confirm a lock. */
  const supportStatus = () => ({
    state: explorer.connection.state.kind,
    badge: explorer.support.provideFileDecoration(moduleUri)?.badge,
    loading: explorer.support.loading,
    failed: explorer.support.failed,
    snapshots: [...explorer.support.snapshots.values()].map(snapshot => ({
      file: snapshot.files.find(file => file.path === fixture.module),
      diagnostics: snapshot.diagnostics,
    })),
  });
  await until(() => explorer.support.provideFileDecoration(moduleUri)?.badge === '🔒' && !explorer.support.loading,
    () => `locked module is ready: ${JSON.stringify(supportStatus())}`);

  let entry = await revealFile(explorer.tree, fixture.module);
  assert.ok(entry, 'module is reachable from the ESKA tree');
  await vscode.commands.executeCommand('eska.explorer.openSource', entry);
  let editor = vscode.window.activeTextEditor;
  assert.equal(editor.document.uri.scheme, 'eska-protected');
  assert.equal(editor.document.getText(), original);
  for (const watcher of explorer.watchers) if (typeof watcher.flush === 'function') await watcher.flush();
  const generation = explorer.tree.projects[0].info.generation;
  const eventCount = trace.filter(value => value?.fileEvent).length;
  let virtualEvents = 0;
  const probe = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(vscode.Uri.file(fixture.source), '**/*'));
  probe.onDidChange(uri => { if (uri.scheme === 'eska-protected') virtualEvents++; });
  explorer.protectedSources.refresh(moduleUri);
  await until(() => virtualEvents > 0, 'the native path-only watcher receives the virtual provider event');
  await new Promise(resolve => setTimeout(resolve, 250));
  probe.dispose();
  assert.equal(trace.filter(value => value?.fileEvent).length, eventCount, 'virtual updates are not native source changes');
  assert.equal(explorer.tree.projects[0].info.generation, generation, 'a protected refresh cannot invalidate the metadata project');
  await vscode.commands.executeCommand('type', { text: '// blocked\n' });
  assert.equal(editor.document.getText(), original);
  await vscode.commands.executeCommand('workbench.action.files.setActiveEditorWriteableInSession');
  await vscode.commands.executeCommand('type', { text: '// still blocked\n' });
  assert.equal(editor.document.getText(), original, 'session writable command cannot unlock provider');
  await assert.rejects(vscode.workspace.fs.writeFile(editor.document.uri, Buffer.from('// bypass\n')));
  await vscode.commands.executeCommand('eska.explorer.revealActiveFile');
  await until(() => explorer.view.selection[0]?.key === entry.key, 'protected source reveals original tree entry');

  const updated = '// updated externally\r\n';
  await fs.writeFile(fixture.module, updated);
  await until(() => editor.document.getText() === updated, 'protected view follows source changes');

  let xmlEntry;
  await until(async () => {
    try { xmlEntry = await revealFile(explorer.tree, fixture.descriptor); return !!xmlEntry; }
    catch (error) { if (error.code === 'sourceChanged') return false; throw error; }
  }, 'XML remains reachable after source changes');
  await vscode.commands.executeCommand('eska.explorer.openXml', xmlEntry);
  const xmlEditor = vscode.window.activeTextEditor;
  assert.equal(xmlEditor.document.uri.scheme, 'eska-protected');
  assert.equal(xmlEditor.document.getText(xmlEditor.selection), '<Name>Товары</Name>');
  const xmlText = xmlEditor.document.getText();
  await vscode.commands.executeCommand('workbench.action.files.setActiveEditorWriteableInSession');
  await vscode.commands.executeCommand('type', { text: '<changed/>' });
  assert.equal(xmlEditor.document.getText(), xmlText, 'a mixed XML also resists session overrides');

  await fs.writeFile(rules, support(1));
  await until(() => explorer.support.provideFileDecoration(moduleUri)?.badge === 'S' && !explorer.support.loading,
    () => `support permits editing: ${JSON.stringify(supportStatus())}`);
  const files = vscode.workspace.getConfiguration('files', moduleUri);
  await files.update('readonlyInclude', { ...files.get('readonlyInclude'), '**/*.bsl': true }, vscode.ConfigurationTarget.Workspace);
  await until(async () => {
    try { entry = await revealFile(explorer.tree, fixture.module); return !!entry; }
    catch (error) { if (error.code === 'sourceChanged') return false; throw error; }
  }, 'module remains reachable after support changes');
  await vscode.commands.executeCommand('eska.explorer.openSource', entry);
  editor = vscode.window.activeTextEditor;
  assert.equal(editor.document.uri.scheme, 'file');
  assert.equal(editor.document.getText(), updated);
  await vscode.commands.executeCommand('type', { text: '// user blocked\n' });
  assert.equal(editor.document.getText(), updated, 'voluntary BSL lock remains active');
  await vscode.commands.executeCommand('workbench.action.files.setActiveEditorWriteableInSession');
  await vscode.commands.executeCommand('type', { text: '// user allowed\n' });
  assert.notEqual(editor.document.getText(), updated, 'voluntary lock remains removable');
  assert.equal(await fs.readFile(fixture.module, 'utf8'), updated, 'typing has not saved the file');
  await vscode.commands.executeCommand('workbench.action.revertAndCloseActiveEditor');
  await vscode.commands.executeCommand('eska.explorer.disconnect');
  await fs.writeFile(path.join(fixture.root, 'host-result.json'), JSON.stringify({ passed: true,
    vscode: vscode.version, locale: vscode.env.language, protectedSessionOverride: true, protectedXml: true, sourceRefresh: true,
    voluntaryLock: true, virtualEventsObserved: virtualEvents, virtualEventsDoNotInvalidateSource: true }));
};

const scenario = exports.run;
/** Preserve bounded production diagnostics before the isolated runner removes its fixture. */
exports.run = async function () {
  try { await scenario(); }
  catch (error) {
    const fixture = JSON.parse(process.env.ESKA_HOST_FIXTURE);
    let freshPolicy;
    try {
      const tree = currentExplorer?.tree, project = tree?.projects[0];
      if (project) freshPolicy = await tree.request(project, 'metadata/supportFiles', { paths: [{ value: path.relative(fixture.source, fixture.module), encoding: 'utf-8' }] });
    } catch (failure) { freshPolicy = { code: failure.code, domain: failure.domain, details: failure.details }; }
    await fs.writeFile(path.join(fixture.root, 'host-result.json'), JSON.stringify({ passed: false, error: String(error.stack ?? error), trace, freshPolicy }));
    throw error;
  }
};
