const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const vscode = require('vscode');

/** Bound acceptance waits without tying correctness to the speed of a particular host. */
async function until(predicate) {
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) { if (await predicate()) return; await new Promise(resolve => setTimeout(resolve, 25)); }
  assert.fail('targeted large-project check timed out');
}

/** Large supplied sources stay unchanged; only the disposable workspace receives editor settings. */
exports.run = async function () {
  assert.ok(process.env.ESKA_PERF_PROJECT);
  const fixture = JSON.parse(process.env.ESKA_HOST_FIXTURE);
  const root = process.env.ESKA_PERF_PROJECT;
  const module = path.join(root, 'src/CommonModules/ОбщегоНазначения/Ext/Module.bsl');
  const paths = ['src/Configuration.xml', 'src/Ext/ParentConfigurations.bin', 'src/CommonModules/ОбщегоНазначения.xml'].map(file => path.join(root, file)).concat(module);
  /** Check the exact descriptor, rule and module inputs used by this acceptance run. */
  const hashes = async () => Promise.all(paths.map(async file => crypto.createHash('sha256').update(await fs.readFile(file)).digest('hex')));
  const before = await hashes(), start = Date.now();
  const explorer = await vscode.extensions.all.find(value => value.packageJSON.name === 'eska-explorer').activate();
  const request = explorer.connection.request.bind(explorer.connection);
  let bulk = 0;
  explorer.connection.request = (...args) => { if (args[1] === 'metadata/support') bulk++; return request(...args); };
  await until(() => explorer.connection.state.kind === 'ready');
  const roots = await explorer.getChildren();
  assert.ok(roots.some(item => item.node));
  assert.equal(explorer.support.loading, false);
  const treeReadyMs = Date.now() - start;
  const opening = Date.now();
  const uri = await explorer.support.resolveUri(module);
  assert.equal(uri.scheme, 'eska-protected');
  const checkedMs = Date.now() - opening;
  const document = await vscode.workspace.openTextDocument(uri);
  await vscode.window.showTextDocument(document);
  const protectedOpenMs = Date.now() - opening;
  const text = document.getText();
  await vscode.commands.executeCommand('workbench.action.files.setActiveEditorWriteableInSession');
  await vscode.commands.executeCommand('type', {text:'must stay blocked'});
  assert.equal(document.getText(), text);
  assert.equal(document.isDirty, false);
  const index = explorer.support.fileIndex;
  assert.ok(index.size < 128, 'opening a file must not publish a full inventory');
  const settings = vscode.workspace.getConfiguration('files').get('readonlyInclude') ?? {};
  assert.ok(Object.keys(settings).length < 128, 'settings cover only touched paths');
  assert.equal(bulk, 0);
  assert.deepEqual(await hashes(), before);
  const result = {passed:true,vscode:vscode.version,files:index.size,readonlyRules:Object.keys(settings).length,treeReadyMs,checkedMs,protectedOpenMs,bulkRequests:bulk,inputBytesUnchanged:true};
  await vscode.commands.executeCommand('eska.explorer.disconnect');
  await fs.writeFile(path.join(fixture.root,'host-result.json'), JSON.stringify(result));
};
