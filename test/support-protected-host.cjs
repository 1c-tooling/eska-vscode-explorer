const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const vscode = require('vscode');
const { revealFile } = require('../out/reveal.js');

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
    'support permits editing');
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
    vscode: vscode.version, protectedSessionOverride: true, protectedXml: true, sourceRefresh: true, voluntaryLock: true }));
};
