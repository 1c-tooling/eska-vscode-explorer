const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const vscode = require('vscode');

/** Wait for backend snapshots without opening the ESKA view or selecting a folder. */
async function until(predicate, label) {
  for(let i=0;i<300;i++){if(await predicate())return;await new Promise(resolve=>setTimeout(resolve,100));}
  assert.fail(label);
}
/** Same UUIDs in separate native workspace folders retain independent physical-file policies. */
exports.run = async function () {
  const first=JSON.parse(process.env.ESKA_HOST_FIXTURE),second=JSON.parse(process.env.ESKA_HOST_SECOND_FIXTURE);
  const id='11111111-1111-1111-1111-111111111111';
  for(const [fixture,mode] of [[first,1],[second,0]]){
    await fs.mkdir(path.join(fixture.source,'Ext'),{recursive:true});
    await fs.writeFile(path.join(fixture.source,'Ext/ParentConfigurations.bin'),`{6,0,1,${id},${mode},${id},"1","Vendor","Test",1,1,0,${id},${id},0,0,0,1,0,0,0,1,0,1,0,1,1,1,1}`);
  }
  await vscode.workspace.getConfiguration('files').update('readonlyInclude',{'**/*.os':true},vscode.ConfigurationTarget.Workspace);
  const explorer=await vscode.extensions.all.find(value=>value.packageJSON.name==='eska-explorer').activate();
  const one=vscode.Uri.file(first.module),two=vscode.Uri.file(second.module);
  await until(()=>explorer.support.provideFileDecoration(one)?.badge==='🔒' && explorer.support.provideFileDecoration(two)?.badge==='S','independent native workspace folders');
  const editor=await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(one));
  const original=editor.document.getText();await vscode.commands.executeCommand('type',{text:'blocked'});assert.equal(editor.document.getText(),original);
  const editable=await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(two));
  const before=editable.document.getText();await vscode.commands.executeCommand('type',{text:'// allowed\n'});assert.notEqual(editable.document.getText(),before);
  await vscode.commands.executeCommand('workbench.action.revertAndCloseActiveEditor');
  const rulesPath=path.join(second.source,'Ext/ParentConfigurations.bin');
  await fs.writeFile(rulesPath,(await fs.readFile(rulesPath,'utf8')).replace(`{6,0,1,${id},0,`,`{6,0,1,${id},1,`));
  await until(()=>explorer.support.provideFileDecoration(two)?.badge==='🔒','secondary folder is locked');
  const config=vscode.workspace.getConfiguration('eska.explorer');
  await config.update('supportPolicy',false,vscode.ConfigurationTarget.Workspace);
  await until(()=>explorer.support.ownedRules().length===0 && explorer.supportContexts.connections.length===0,'disable both folders');
  assert.equal(explorer.support.provideFileDecoration(one),undefined);
  assert.equal(explorer.support.provideFileDecoration(two),undefined);
  assert.deepEqual(vscode.workspace.getConfiguration('files').get('readonlyInclude'),{'**/*.os':true});
  await config.update('supportPolicy',true,vscode.ConfigurationTarget.Workspace);
  await until(()=>explorer.support.provideFileDecoration(one)?.badge==='🔒' && explorer.support.provideFileDecoration(two)?.badge==='🔒','re-enable both folders');
  const secondary=explorer.supportContexts.connections[0];
  const target=secondary.state.target;
  await secondary.disconnect();
  await new Promise(resolve=>setTimeout(resolve,500));
  await explorer.support.serial;
  assert.equal(explorer.support.provideFileDecoration(two)?.badge,'?');
  const disconnected=await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(two));
  const unchanged=disconnected.document.getText();
  await vscode.commands.executeCommand('type',{text:'must remain blocked'});
  assert.equal(disconnected.document.getText(),unchanged,'lost secondary session keeps confirmed restriction');
  await secondary.connect(target);
  await until(()=>explorer.support.provideFileDecoration(two)?.badge==='🔒','secondary folder recovers');
  assert.equal(vscode.workspace.updateWorkspaceFolders(0,1),true);
  await until(()=>explorer.support.provideFileDecoration(two)?.badge==='🔒' && !explorer.support.provideFileDecoration(one),'remaining folder stays protected and removed folder is cleaned');
  await vscode.commands.executeCommand('eska.explorer.disconnect');
  await until(()=>Object.keys(vscode.workspace.getConfiguration('files').get('readonlyInclude')).length===1,'cleanup both folders');
  assert.equal(vscode.workspace.getConfiguration('files').get('readonlyInclude')['**/*.os'],true);
  await fs.writeFile(path.join(first.root,'host-result.json'),JSON.stringify({passed:true,vscode:vscode.version,multiRoot:true,liveToggle:true,sameUuidIsolated:true,unopenedTree:true,userSettingsPreserved:true,secondaryDisconnectPreservesLock:true,folderRemoval:true}));
};
