const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const vscode = require('vscode');

/** Observe real normal-workbench restoration; no development or test mode grants access to private adapter objects. */
async function until(predicate, message) {
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    const value = await predicate();
    if (value) return value;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error(message);
}

/** A native transaction changes only the selected text and leaves module saving to the user. */
async function replace(document, before, after) {
  const start = document.getText().indexOf(before); assert.ok(start >= 0);
  const edit = new vscode.WorkspaceEdit();
  edit.replace(document.uri, new vscode.Range(document.positionAt(start), document.positionAt(start + before.length)), after);
  assert.equal(await vscode.workspace.applyEdit(edit), true);
}

/** Two fully installed IDE processes retain both drafts, then require explicit resume and Apply through public commands. */
exports.run = async function () {
  assert.ok(process.env.ESKA_HOST_RESTART && process.env.ESKA_TEST_VSIX);
  assert.equal(vscode.env.language, process.env.ESKA_HOST_LOCALE ?? 'en');
  const fixture = JSON.parse(process.env.ESKA_HOST_FIXTURE);
  const marker = path.join(fixture.root, 'bsl-native-recovery.json');
  if (process.env.ESKA_HOST_RUN === '0') {
    const owner = await vscode.workspace.openTextDocument(vscode.Uri.file(fixture.module));
    const disk = await fs.readFile(fixture.module);
    await replace(owner, 'Other = 42', 'Other = 43');
    const editor = await vscode.window.showTextDocument(owner, { preview: false });
    const at = owner.positionAt(owner.getText().indexOf('SELECT 1') + 3);
    editor.selection = new vscode.Selection(at, at);
    await vscode.commands.executeCommand('eska.explorer.editBslQuery');
    const draft = await until(() => vscode.window.activeTextEditor?.document.uri.scheme === 'eska-query'
      && vscode.window.activeTextEditor.document, 'public command opened query');
    await replace(draft, 'SELECT 1', 'SELECT 6');
    assert.equal(await draft.save(), true);
    assert.deepEqual(await fs.readFile(fixture.module), disk);
    await fs.writeFile(marker, JSON.stringify({ owner: owner.getText(), draft: draft.getText(), uri: draft.uri.toString(), disk: disk.toString('hex') }));
  } else {
    const checkpoint = JSON.parse(await fs.readFile(marker, 'utf8'));
    const editor = await until(() => vscode.window.visibleTextEditors.find(editor => editor.document.uri.toString() === checkpoint.uri),
      'normal workbench restored the query tab');
    assert.equal(editor.document.getText(), checkpoint.draft);
    const owner = await vscode.workspace.openTextDocument(vscode.Uri.file(fixture.module));
    assert.equal(owner.getText(), checkpoint.owner, 'Native hot exit restored the dirty parent');
    await vscode.commands.executeCommand('eska.explorer.applyQuery', editor.document.uri);
    assert.equal(owner.getText(), checkpoint.owner, 'restoration never resumes or applies automatically');
    await vscode.commands.executeCommand('eska.explorer.resumeQuery');
    await vscode.commands.executeCommand('eska.explorer.applyQuery', editor.document.uri);
    await until(() => owner.getText() === checkpoint.owner.replace('SELECT 1', 'SELECT 6'), 'explicit resumed Apply updates the native model');
    assert.equal((await fs.readFile(fixture.module)).toString('hex'), checkpoint.disk);
    await vscode.window.showTextDocument(owner, { preview: false });
    await vscode.commands.executeCommand('undo');
    assert.equal(owner.getText(), checkpoint.owner);
    await vscode.commands.executeCommand('redo');
    assert.equal(owner.getText(), checkpoint.owner.replace('SELECT 1', 'SELECT 6'));
  }
  await fs.writeFile(path.join(fixture.root, 'host-result.json'), JSON.stringify({ passed: true, suite: 'bsl-native-recovery',
    run: process.env.ESKA_HOST_RUN, locale: vscode.env.language, vscode: vscode.version, installedNormalProcesses: true }));
};
