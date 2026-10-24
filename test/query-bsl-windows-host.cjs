const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const vscode = require('vscode');

/** Share only atomic test markers between two actual extension-host processes in one private normal IDE profile. */
async function publish(file, value) {
  const temporary = file + '.' + process.pid;
  await fs.writeFile(temporary, JSON.stringify(value));
  await fs.rename(temporary, file);
}

/** Wait for a bounded cross-window transition while source buffers and saves remain native. */
async function until(predicate, message) {
  const deadline = Date.now() + 40000;
  while (Date.now() < deadline) {
    const value = await predicate();
    if (value) return value;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error(message);
}

/** Change only the selected native text; the caller decides whether that window saves its source. */
async function replace(document, before, after) {
  const start = document.getText().indexOf(before); assert.ok(start >= 0);
  const edit = new vscode.WorkspaceEdit();
  edit.replace(document.uri, new vscode.Range(document.positionAt(start), document.positionAt(start + before.length)), after);
  assert.equal(await vscode.workspace.applyEdit(edit), true);
}

/** A second real window saves the module; the first must retain both its dirty owner and unapplied query. */
exports.run = async function () {
  const fixture = JSON.parse(process.env.ESKA_HOST_FIXTURE);
  const ready = path.join(fixture.root, 'first-window-ready.json');
  const written = path.join(fixture.root, 'second-window-written.json');
  let first = false;
  try { await (await fs.open(path.join(fixture.root, 'window-role'), 'wx')).close(); first = true; }
  catch (error) { if (error.code !== 'EEXIST') throw error; }
  if (!first) {
    await until(() => fs.readFile(ready, 'utf8').then(JSON.parse).catch(() => undefined), 'first window captured a query');
    const owner = await vscode.workspace.openTextDocument(vscode.Uri.file(fixture.module));
    await vscode.window.showTextDocument(owner, { preview: false });
    await replace(owner, 'Other = 42', 'Other = 99');
    assert.equal(await owner.save(), true);
    await publish(written, { pid: process.pid, source: owner.getText(), disk: (await fs.readFile(fixture.module)).toString('hex') });
    return;
  }
  const owner = await vscode.workspace.openTextDocument(vscode.Uri.file(fixture.module));
  await replace(owner, 'Other = 42', 'Other = 43');
  const captured = owner.getText();
  const editor = await vscode.window.showTextDocument(owner, { preview: false });
  const at = owner.positionAt(captured.indexOf('SELECT 1') + 3);
  editor.selection = new vscode.Selection(at, at);
  await vscode.commands.executeCommand('eska.explorer.editBslQuery');
  const draft = await until(() => vscode.window.activeTextEditor?.document.uri.scheme === 'eska-query'
    && vscode.window.activeTextEditor.document, 'query opened in first window');
  await replace(draft, 'SELECT 1', 'SELECT 6');
  assert.equal(await draft.save(), true);
  await publish(ready, { pid: process.pid });
  const isolated = path.dirname(fixture.root);
  const workspace = path.join(isolated, 'second-window.code-workspace');
  await fs.writeFile(workspace, JSON.stringify({ folders: [{ path: fixture.root }] }));
  await promisify(execFile)(process.env.VSCODE_EXECUTABLE ?? 'codium', [`--user-data-dir=${path.join(isolated, 'profile')}`,
    `--extensions-dir=${path.join(isolated, 'extensions')}`, '--disable-workspace-trust', '--new-window', workspace]);
  const second = await until(() => fs.readFile(written, 'utf8').then(JSON.parse).catch(() => undefined), 'second native window saved module');
  assert.notEqual(second.pid, process.pid);
  await vscode.window.showTextDocument(draft, { preview: false });
  await vscode.commands.executeCommand('eska.explorer.applyQuery', draft.uri);
  assert.equal(owner.getText(), captured, 'first dirty parent is not overwritten');
  assert.equal(draft.getText(), 'SELECT 6\nAS Value', 'query draft remains available');
  assert.equal((await fs.readFile(fixture.module)).toString('hex'), second.disk, 'second window source stays intact');
  assert.ok(second.source.includes('Other = 99'));
  await vscode.commands.executeCommand('eska.explorer.cancelQuery', draft.uri);
  await publish(path.join(fixture.root, 'host-result.json'), { passed: true, suite: 'bsl-two-native-windows',
    locale: vscode.env.language, vscode: vscode.version, extensionHosts: [process.pid, second.pid], dirtyParentPreserved: true,
    externalSourcePreserved: true, draftPreservedOnConflict: true });
};
