const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const vscode = require('vscode');

/** Wait for lifecycle transitions without assuming backend or editor timing. */
async function until(predicate, reason) {
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  assert.fail(reason);
}

/** Verify opt-out startup, native editing, re-enable and cancellation of a pending response. */
exports.run = async function () {
  const fixture = JSON.parse(process.env.ESKA_HOST_FIXTURE);
  const config = vscode.workspace.getConfiguration('eska.explorer');
  assert.equal(config.get('supportPolicy'), false, 'runner starts with support disabled');
  const owner = '11111111-1111-1111-1111-111111111111';
  const child = '22222222-2222-2222-2222-222222222222';
  const rules = path.join(fixture.source, 'Ext/ParentConfigurations.bin');
  await fs.mkdir(path.dirname(rules), { recursive: true });
  await fs.writeFile(rules, `{6,0,1,${owner},0,${owner},"1","Vendor","Fixture",2,0,0,${owner},${owner},0,0,${child},${child},0,0,0,1,0,0,0,1,0,1,0,1,1,1,1}`);
  const files = vscode.workspace.getConfiguration('files');
  await files.update('readonlyInclude', { '**/*.os': true }, vscode.ConfigurationTarget.Workspace);
  const explorer = await vscode.extensions.all.find(value => value.packageJSON.name === 'eska-explorer').activate();
  await until(() => explorer.tree && !explorer.support.loading, 'tree without support preloader');
  assert.ok((await explorer.getChildren()).length);
  assert.equal(explorer.support.snapshots.size, 0);
  assert.equal(explorer.supportContexts.connections.length, 0);
  const uri = vscode.Uri.file(fixture.module);
  assert.equal(explorer.support.provideFileDecoration(uri), undefined);
  let editor = await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(uri));
  const original = editor.document.getText();
  await vscode.commands.executeCommand('type', { text: '// disabled\n' });
  assert.notEqual(editor.document.getText(), original);
  await vscode.commands.executeCommand('workbench.action.revertAndCloseActiveEditor');
  await config.update('supportPolicy', true, vscode.ConfigurationTarget.Workspace);
  await until(() => !explorer.support.loading && explorer.support.provideFileDecoration(uri)?.badge === '🔒', 'enabled protection');
  editor = await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(uri));
  await vscode.commands.executeCommand('type', { text: 'blocked' });
  assert.equal(editor.document.getText(), original);
  await config.update('supportPolicy', false, vscode.ConfigurationTarget.Workspace);
  await until(() => explorer.support.ownedRules().length === 0 && !explorer.support.loading, 'disabled cleanup');
  assert.deepEqual(vscode.workspace.getConfiguration('files').get('readonlyInclude'), { '**/*.os': true });
  assert.equal(explorer.support.provideFileDecoration(uri), undefined);
  await vscode.commands.executeCommand('type', { text: '// writable again\n' });
  assert.notEqual(editor.document.getText(), original);
  await vscode.commands.executeCommand('workbench.action.revertAndCloseActiveEditor');

  const tree = explorer.tree;
  const request = tree.request.bind(tree);
  let release;
  let arrived = false;
  const gate = new Promise(resolve => { release = resolve; });
  tree.request = async (...args) => {
    const result = await request(...args);
    if (args[1] === 'metadata/support') { arrived = true; await gate; }
    return result;
  };
  await config.update('supportPolicy', true, vscode.ConfigurationTarget.Workspace);
  await until(() => arrived, 'pending support response');
  await config.update('supportPolicy', false, vscode.ConfigurationTarget.Workspace);
  await until(() => !explorer.support.loading, 'disable invalidates pending work');
  release();
  await until(() => explorer.support.ownedRules().length === 0, 'pending response cannot restore restrictions');
  await new Promise(resolve => setTimeout(resolve, 300));
  await explorer.support.serial;
  assert.equal(explorer.support.snapshots.size, 0);
  assert.deepEqual(vscode.workspace.getConfiguration('files').get('readonlyInclude'), { '**/*.os': true });
  tree.request = request;
  await config.update('supportPolicy', true, vscode.ConfigurationTarget.Workspace);
  await until(() => !explorer.support.loading && explorer.support.provideFileDecoration(uri)?.badge === '🔒', 're-enabled after cancellation');
  await vscode.commands.executeCommand('eska.explorer.disconnect');
  await until(() => explorer.support.ownedRules().length === 0, 'disconnect cleanup');
  await fs.writeFile(path.join(fixture.root, 'host-result.json'), JSON.stringify({ passed: true, disabledStartup: true, nativeEditing: true, liveToggle: true, pendingCancelled: true, userRulesPreserved: true }));
};
