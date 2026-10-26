const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const path=require('node:path');
const vscode=require('vscode');
const {connect}=require('./query-constructor-dom.cjs');
const {until,openQuery}=require('./query-modal-host.cjs');
const {ready,form}=require('./query-builder-host.cjs');

/** Missing UNION cells are inspected and explicitly previewed before any accepted revision changes. */
exports.run=async function(){
 const f=JSON.parse(process.env.ESKA_HOST_FIXTURE);let client;
 try{
  await vscode.extensions.all.find(value=>value.packageJSON.name==='eska-explorer').activate();await vscode.commands.executeCommand('eska.explorer.restart');
  const disk=await fs.readFile(f.module),draft=await openQuery(vscode.Uri.file(f.module));
  const text='SELECT 1 AS N UNION ALL SELECT 2 AS N, 3 AS Extra',edit=new vscode.WorkspaceEdit();edit.replace(draft.uri,new vscode.Range(draft.positionAt(0),draft.positionAt(draft.getText().length)),text);assert.equal(await vscode.workspace.applyEdit(edit),true);
  await vscode.commands.executeCommand('eska.explorer.queryConstructor',draft.uri);client=await connect(until);await ready(client);
  await client.evaluate('document.getElementById("tab-unions").click()');assert.equal(await client.evaluate('document.querySelectorAll(".union-matrix tr").length'),3);
  assert.equal(await client.evaluate('document.getElementById("query-text").textContent'),text);
  await client.evaluate('document.querySelector(".align-union").click()');await until(()=>client.evaluate('!!document.querySelector(".action-preview")'),'alignment preview');await ready(client);
  assert.match(await client.evaluate('document.querySelector(".preview-diff").textContent'),/NULL AS Extra/);
  assert.equal(await client.evaluate('document.getElementById("query-page").inert'),true);
  await client.evaluate('document.querySelector(".preview-cancel").click()');await until(()=>client.evaluate('!document.querySelector(".action-preview")'),'preview cancelled');assert.equal(await client.evaluate('document.getElementById("query-text").textContent'),text);
  await client.evaluate('document.querySelector(".align-union").click()');await until(()=>client.evaluate('!!document.querySelector(".preview-accept")'),'second preview');await ready(client);await client.evaluate('document.querySelector(".preview-accept").click()');
  await until(()=>client.evaluate('document.getElementById("query-text").textContent.includes("NULL AS Extra")'),'alignment explicitly accepted');await ready(client);
  await client.evaluate('document.querySelector(".matrix-cell").click()');await form(client,{expression:'1',alias:'ResultName'});
  assert.equal(await client.evaluate('document.querySelector(".matrix-column").textContent'),'ResultName');
  await client.evaluate('document.querySelector(".matrix-move:last-child").click()');await until(()=>client.evaluate('!!document.querySelector(".action-preview")'),'column move preview');await ready(client);await client.evaluate('document.querySelector(".preview-accept").click()');await until(()=>client.evaluate('!document.querySelector(".action-preview")'),'column move accepted');await ready(client);
  assert.equal(await client.evaluate('document.querySelector(".matrix-column").textContent'),'Extra');
  const changed=await client.evaluate('document.getElementById("query-text").textContent');await client.evaluate('document.querySelector("header button").click()');client.close();client=undefined;await until(()=>draft.getText()===changed,'matrix applied');await vscode.commands.executeCommand('undo');assert.equal(draft.getText(),text);assert.deepEqual(await fs.readFile(f.module),disk);
  await fs.writeFile(path.join(f.root,'host-result.json'),JSON.stringify({passed:true,suite:'query-union-matrix',locale:vscode.env.language,accepted:['matrix-read-noop','alignment-preview-cancel','alignment-explicit-accept','parent-inert','shared-output-alias','column-move-preview','native-undo','owner-unchanged']}));
 }finally{client?.close();}
};
