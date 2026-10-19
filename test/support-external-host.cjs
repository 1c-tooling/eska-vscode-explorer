const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash } = require('node:crypto');
const vscode = require('vscode');
const { revealFile } = require('../out/reveal.js');

/** Wait for actual support requests and editor transitions without assuming startup timing. */
async function until(predicate, reason) {
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  assert.fail(reason);
}

/** A standalone form keeps voluntary BSL locking removable through the command palette. */
exports.run = async function () {
  const fixture = JSON.parse(process.env.ESKA_HOST_FIXTURE);
  assert.ok(['processing', 'report'].includes(process.env.ESKA_HOST_PROJECT_TYPE));
  const { descriptor } = await import('./fixture.mjs');
  const form = path.join(fixture.source, 'Тест', 'Forms', 'Форма');
  const module = path.join(form, 'Ext', 'Form', 'Module.bsl');
  await fs.mkdir(path.dirname(module), { recursive: true });
  await fs.writeFile(form + '.xml', descriptor('Form', 'Форма'));
  await fs.writeFile(fixture.descriptor, (await fs.readFile(fixture.descriptor, 'utf8'))
    .replace('<ChildObjects>', '<ChildObjects><Form>Форма</Form>'));
  await fs.writeFile(module, '// Внешняя форма\r\n');
  const original = await fs.readFile(module, 'utf8');
  const extension = vscode.extensions.all.find(value => value.packageJSON.name === 'eska-explorer');
  const explorer = await extension.activate();
  await until(() => explorer.connection.state.kind === 'ready' && explorer.support.targeted, 'external project connects');
  await explorer.support.serial;

  const directories = [path.dirname(form), form, path.dirname(module)];
  const userRules = { '**/*.bsl': true, '**/*.os': true };
  await explorer.support.context.workspaceState.update('supportReadonlyRules.v2',
    directories.map(directory => createHash('sha256').update(directory).digest('base64')));
  const files = vscode.workspace.getConfiguration('files', vscode.Uri.file(fixture.root));
  await files.update('readonlyInclude', { ...userRules, ...Object.fromEntries(directories.map(directory => [directory, true])) },
    vscode.ConfigurationTarget.Workspace);
  const requests = [];
  const request = explorer.connection.request.bind(explorer.connection);
  explorer.connection.request = async (session, method, params, ...rest) => {
    if (method === 'metadata/supportFiles') requests.push(...params.paths.map(value => value.value));
    return request(session, method, params, ...rest);
  };
  const uri = vscode.Uri.file(module);
  for (const directory of directories) explorer.support.provideFileDecoration(vscode.Uri.file(directory));
  explorer.support.provideFileDecoration(uri);
  await until(() => explorer.support.fileIndex.get(uri.toString())?.file.readOnly === false
    && directories.every(directory => !(directory in files.get('readonlyInclude', {}))), 'external policy removes stale directory locks');
  assert.ok(requests.length > 0);
  assert.ok(directories.every(directory => !requests.includes(path.relative(fixture.source, directory))), 'directories never enter file-policy requests');
  assert.deepEqual(files.inspect('readonlyInclude').workspaceValue, userRules, 'user locks remain intact');
  assert.equal((await explorer.support.resolveUri(module)).scheme, 'file');
  const entry = await revealFile(explorer.tree, module);
  assert.ok(entry, 'external form belongs to the metadata tree');
  assert.equal(entry.target, 'form-module');
  await vscode.commands.executeCommand('eska.explorer.openFormSource', entry);
  await until(() => vscode.window.activeTextEditor?.document.uri.toString() === uri.toString(), 'form opens as an ordinary file');
  const editor = vscode.window.activeTextEditor;
  await vscode.commands.executeCommand('type', { text: '// blocked\n' });
  assert.equal(editor.document.getText(), original, 'voluntary lock still blocks input');
  await vscode.commands.executeCommand('workbench.action.files.setActiveEditorWriteableInSession');
  await vscode.commands.executeCommand('type', { text: '// unlocked\n' });
  assert.notEqual(editor.document.getText(), original, 'session command unlocks the external form');
  assert.equal(await fs.readFile(module, 'utf8'), original, 'unsaved test input never changes source bytes');
  await vscode.commands.executeCommand('workbench.action.revertAndCloseActiveEditor');
  await vscode.commands.executeCommand('eska.explorer.disconnect');
  await fs.writeFile(path.join(fixture.root, 'host-result.json'), JSON.stringify({
    passed: true, type: process.env.ESKA_HOST_PROJECT_TYPE, vscode: vscode.version,
    formEditable: true, sessionUnlock: true, staleDirectoryLocksRemoved: true, userRulesPreserved: true,
  }));
};
