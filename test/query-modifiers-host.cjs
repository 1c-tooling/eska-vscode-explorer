const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const path=require('node:path');
const vscode=require('vscode');
const {connect}=require('./query-constructor-dom.cjs');
const {until,openQuery}=require('./query-modal-host.cjs');
const {ready}=require('./query-builder-host.cjs');

/** Query settings remain an input buffer until a checked preview is explicitly accepted. */
exports.run=async function(){
 const f=JSON.parse(process.env.ESKA_HOST_FIXTURE);let client;
 try{
  await vscode.extensions.all.find(value=>value.packageJSON.name==='eska-explorer').activate();await vscode.commands.executeCommand('eska.explorer.restart');
  const disk=await fs.readFile(f.module),draft=await openQuery(vscode.Uri.file(f.module)),before=draft.getText();
  await vscode.commands.executeCommand('eska.explorer.queryConstructor',draft.uri);client=await connect(until);await ready(client);
  await client.evaluate('document.querySelector(".query-settings").click();for(const name of ["distinct","allowed","autoOrder"]){const input=document.querySelector(".modifier-expression [name="+name+"]");input.click();}const topInput=document.querySelector(".modifier-expression [name=top]");topInput.value="0";topInput.dispatchEvent(new Event("input",{bubbles:true}));document.querySelector(".modifier-expression").requestSubmit();');await until(()=>client.evaluate('!!document.querySelector(".action-preview")'),'settings preview');await ready(client);
  assert.match(await client.evaluate('document.querySelector(".preview-diff").textContent'),/ALLOWED DISTINCT TOP 0/);assert.equal(await client.evaluate('document.getElementById("query-text").textContent'),before);
  await client.evaluate('document.querySelector(".preview-cancel").click()');await until(()=>client.evaluate('!document.querySelector(".action-preview")'),'settings cancel returns input');assert.equal(await client.evaluate('document.querySelector(".modifier-expression [name=top]").value'),'0');assert.equal(await client.evaluate('document.getElementById("query-text").textContent'),before);
  await client.evaluate('document.querySelector(".modifier-expression").requestSubmit()');await until(()=>client.evaluate('!!document.querySelector(".action-preview")'),'settings second preview');await ready(client);await client.evaluate('document.querySelector(".preview-accept").click()');await until(()=>client.evaluate('document.getElementById("query-text").textContent.includes("TOP 0")&&!document.querySelector(".action-preview")'),'settings accepted');await ready(client);assert.equal(await client.evaluate('!!document.querySelector(".modifier-expression")'),false);
  const changed=await client.evaluate('document.getElementById("query-text").textContent');assert.match(changed,/AUTOORDER/);await client.evaluate('document.querySelector("header button").click()');client.close();client=undefined;await until(()=>draft.getText()===changed,'settings applied');await vscode.commands.executeCommand('undo');assert.equal(draft.getText(),before);await vscode.commands.executeCommand('redo');assert.equal(draft.getText(),changed);assert.deepEqual(await fs.readFile(f.module),disk);
  await fs.writeFile(path.join(f.root,'host-result.json'),JSON.stringify({passed:true,suite:'query-modifiers',locale:vscode.env.language,accepted:['typed-settings','preview-does-not-mutate','cancel-keeps-input','explicit-accept','native-undo-redo','source-unchanged']}));
 }finally{client?.close();}
};
