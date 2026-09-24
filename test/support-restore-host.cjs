const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const vscode = require('vscode');

/** Wait for workbench restoration without opening or activating anything from the test. */
async function restored(uri) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    const editor = vscode.window.visibleTextEditors.find(editor => editor.document.uri.toString() === uri.toString());
    if (editor) return editor;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.fail('protected editor was not restored by the workbench');
}

/** Save a protected tab, then validate it in a fresh IDE process using the same profile. */
exports.run = async function () {
  assert.ok(process.env.ESKA_HOST_RESTART, 'run with ESKA_HOST_RESTART=1');
  const fixture = JSON.parse(process.env.ESKA_HOST_FIXTURE);
  const uri = vscode.Uri.file(fixture.module).with({ scheme: 'eska-protected' });
  if (process.env.ESKA_HOST_RUN === '0') {
    // Remove other activation triggers: the second launch has no eska.toml or ESKA view.
    await fs.rm(path.join(fixture.root, 'eska.toml'));
    await vscode.commands.executeCommand('workbench.action.closeSidebar');
    await vscode.workspace.getConfiguration('workbench.editor').update('restoreViewState', true, vscode.ConfigurationTarget.Global);
    const document = await vscode.workspace.openTextDocument(uri);
    await vscode.window.showTextDocument(document, { preview: false });
  } else {
    const editor = await restored(uri);
    const original = await fs.readFile(fixture.module, 'utf8');
    assert.equal(editor.document.getText(), original);
    assert.equal(vscode.extensions.all.find(extension => extension.packageJSON.name === 'eska-explorer').isActive, true);
    await vscode.commands.executeCommand('type', { text: '// forbidden\n' });
    assert.equal(editor.document.getText(), original, 'restored editor is still readonly');
  }
  await fs.writeFile(path.join(fixture.root, 'host-result.json'), JSON.stringify({ passed: true,
    suite: 'support-restore', run: process.env.ESKA_HOST_RUN, vscode: vscode.version }));
};
