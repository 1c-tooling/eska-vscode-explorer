const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const vscode = require('vscode');

/** Read-only acceptance of large supplied sources; only the disposable workspace gets settings. */
exports.run = async function () {
  assert.ok(process.env.ESKA_PERF_PROJECT);
  const fixture=JSON.parse(process.env.ESKA_HOST_FIXTURE);
  const root=process.env.ESKA_PERF_PROJECT;
  const paths=['src/Configuration.xml','src/Ext/ParentConfigurations.bin'].map(file=>path.join(root,file));
  /** Compare source bytes without loading or saving a user editor document. */
  const hashes=async()=>Promise.all(paths.map(async file=>crypto.createHash('sha256').update(await fs.readFile(file)).digest('hex')));
  const before=await hashes(),start=Date.now();
  const explorer=await vscode.extensions.all.find(value=>value.packageJSON.name==='eska-explorer').activate();
  while(Date.now()-start<300000 && ![...explorer.support.fileIndex.values()].some(value=>value.file.readOnly)) await new Promise(resolve=>setTimeout(resolve,250));
  const index=explorer.support.fileIndex;
  assert.ok(index.size>10000,'large policy published');
  const settings=vscode.workspace.getConfiguration('files').get('readonlyInclude');
  assert.ok(Object.keys(settings).length>0 && Object.keys(settings).length<2000,'bounded exact-file settings applied to isolated workspace');
  const locked=[...index.values()].find(value=>value.file.readOnly && value.file.path.endsWith('.bsl'));
  const document=await vscode.workspace.openTextDocument(vscode.Uri.file(locked.file.path));
  await vscode.window.showTextDocument(document);
  const text=document.getText();
  await vscode.commands.executeCommand('type',{text:'must stay blocked'});
  assert.equal(document.getText(),text);
  assert.equal(document.isDirty,false);
  const tick=Date.now();
  const roots=await explorer.getChildren();
  assert.ok(roots.some(item=>item.node));
  assert.deepEqual(await hashes(),before);
  const result={passed:true,vscode:vscode.version,files:index.size,readonlyRules:Object.keys(settings).length,initialMs:Date.now()-start,rootMs:Date.now()-tick,rootAndSupportBytesUnchanged:true};
  await vscode.commands.executeCommand('eska.explorer.disconnect');
  await fs.writeFile(path.join(fixture.root,'host-result.json'),JSON.stringify(result));
};
