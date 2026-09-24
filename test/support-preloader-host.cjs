const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const vscode = require('vscode');

/** Wait for actual editor and backend transitions with a bounded deadline. */
async function until(predicate, reason) {
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) { if (await predicate()) return; await new Promise(resolve => setTimeout(resolve, 25)); }
  assert.fail(reason);
}

/** A delayed permission check never hides the tree; native locked files use the immutable provider. */
exports.run = async function () {
  const fixture = JSON.parse(process.env.ESKA_HOST_FIXTURE);
  const uuid = '11111111-1111-1111-1111-111111111111';
  const rules = rule => `{6,0,1,${uuid},0,${uuid},"1","Vendor","Test",1,${rule},0,${uuid},${uuid},0,0,0,1,0,0,0,1,0,1,0,1,1,1,1}`;
  const file = path.join(fixture.source, 'Ext/ParentConfigurations.bin');
  await fs.mkdir(path.dirname(file), {recursive:true});
  await fs.writeFile(file, rules(0));
  const original = await fs.readFile(fixture.module, 'utf8');
  const explorer = await vscode.extensions.all.find(value => value.packageJSON.name === 'eska-explorer').activate();
  let release;
  const barrier = new Promise(resolve => { release = resolve; });
  const request = explorer.connection.request.bind(explorer.connection);
  let targeted = 0, bulk = 0;
  explorer.connection.request = async (session, method, params, ...rest) => {
    if (method === 'metadata/support') { bulk++; throw new Error('unexpected full support inventory'); }
    if (method === 'metadata/supportFiles') { targeted++; await barrier; }
    return request(session, method, params, ...rest);
  };
  try {
    await until(() => explorer.connection.state.kind === 'ready' && explorer.support.targeted, 'targeted backend ready');
    const uri = vscode.Uri.file(fixture.module);
    explorer.support.provideFileDecoration(uri);
    await until(() => targeted > 0, 'targeted request starts');
    const rows = await explorer.getChildren();
    assert.ok(rows.some(row => row.node), 'tree stays available during permission check');
    assert.equal(explorer.support.loading, false);
    assert.equal(bulk, 0);
    release();
    await until(() => explorer.support.provideFileDecoration(uri)?.badge === '🔒', 'locked module ready');
    await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(uri));
    await until(() => vscode.window.activeTextEditor?.document.uri.scheme === 'eska-protected', 'native open redirects to protected provider');
    let editor = vscode.window.activeTextEditor;
    await vscode.commands.executeCommand('workbench.action.files.setActiveEditorWriteableInSession');
    await vscode.commands.executeCommand('type', {text:'blocked'});
    assert.equal(editor.document.getText(), original, 'session override cannot unlock native open');
    await assert.rejects(vscode.workspace.fs.writeFile(editor.document.uri, Buffer.from('blocked')));

    // Query immediately after a branch-like rewrite, without waiting for the watcher.
    await fs.writeFile(file, rules(1));
    await until(async () => (await explorer.support.resolveUri(fixture.module)).scheme === 'file', 'current bytes allow editable-with-support');
    editor = await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(uri));
    await vscode.commands.executeCommand('type', {text:'// unsaved\n'});
    const dirty = editor.document.getText();
    assert.notEqual(dirty, original);
    await fs.writeFile(file, rules(0));
    await until(() => explorer.support.provideFileDecoration(uri)?.badge === '🔒', 'branch switch closes dirty native file for new edits');
    await vscode.commands.executeCommand('type', {text:'blocked'});
    assert.equal(editor.document.getText(), dirty, 'dirty text is preserved');
    assert.equal(await fs.readFile(fixture.module, 'utf8'), original);
    await vscode.commands.executeCommand('workbench.action.revertAndCloseActiveEditor');
    await fs.writeFile(file, 'damaged');
    assert.equal((await explorer.support.resolveUri(fixture.module)).scheme, 'eska-protected', 'unknown policy is immutable');
    await fs.writeFile(file, rules(1));
    await until(async () => (await explorer.support.resolveUri(fixture.module)).scheme === 'file', 'A-B-A rule change recovers');
    assert.equal(bulk, 0, 'no startup, reopen or branch change requested an inventory');
    await vscode.commands.executeCommand('eska.explorer.disconnect');
    await fs.writeFile(path.join(fixture.root,'host-result.json'), JSON.stringify({passed:true,lazyTree:true,targetedRequests:targeted,bulkRequests:bulk,nativeProtected:true,dirtyPreserved:true,currentBytes:true}));
  } finally { release(); }
};
