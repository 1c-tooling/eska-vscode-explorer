const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const vscode = require('vscode');

/** Exercise native typing, session overrides and dirty editors on ordinary file URIs. */
exports.run = async function () {
  const fixture = JSON.parse(process.env.ESKA_HOST_FIXTURE);
  const uri = vscode.Uri.file(fixture.module);
  const editor = await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(uri));
  const original = editor.document.getText();
  const configuration = vscode.workspace.getConfiguration('files', uri);
  await configuration.update('readonlyInclude', { '**/*.bsl': true, '**/*.os': true }, vscode.ConfigurationTarget.Workspace);
  await new Promise(resolve => setTimeout(resolve, 300));
  await vscode.commands.executeCommand('type', { text: 'blocked' });
  assert.equal(editor.document.getText(), original);
  await vscode.commands.executeCommand('workbench.action.files.setActiveEditorWriteableInSession');
  await vscode.commands.executeCommand('type', { text: '// session\n' });
  assert.notEqual(editor.document.getText(), original);
  const dirty = editor.document.getText();
  assert.equal(editor.document.isDirty, true);
  await configuration.update('readonlyInclude', { '**/*.bsl': true, '**/*.os': true, [fixture.module]: true }, vscode.ConfigurationTarget.Workspace);
  await new Promise(resolve => setTimeout(resolve, 300));
  await vscode.commands.executeCommand('type', { text: '// override persists\n' });
  assert.notEqual(editor.document.getText(), dirty);
  assert.equal(await fs.readFile(fixture.module, 'utf8'), original);
  await fs.writeFile(path.join(fixture.root, 'host-result.json'), JSON.stringify({ passed: true, vscode: vscode.version, normalFileReadonly: true, sessionOverrideWins: true, dirtyTextPreserved: true }));
  await vscode.commands.executeCommand('workbench.action.revertAndCloseActiveEditor');
};
