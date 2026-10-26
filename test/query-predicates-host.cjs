const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const path=require('node:path');
const vscode=require('vscode');
const {connect}=require('./query-constructor-dom.cjs');
const {until,openQuery}=require('./query-modal-host.cjs');
const {ready}=require('./query-builder-host.cjs');

/** Native controls edit a recursive value tree and send one checked predicate intention to ESKA. */
exports.run=async function(){
 const f=JSON.parse(process.env.ESKA_HOST_FIXTURE);let client;
 try{
  await vscode.extensions.all.find(value=>value.packageJSON.name==='eska-explorer').activate();await vscode.commands.executeCommand('eska.explorer.restart');
  const disk=await fs.readFile(f.module),draft=await openQuery(vscode.Uri.file(f.module)),before=draft.getText();
  await vscode.commands.executeCommand('eska.explorer.queryConstructor',draft.uri);client=await connect(until);await ready(client);
  await client.evaluate(`document.getElementById('tab-conditions').click();document.querySelector('[data-section=conditions] .edit-predicate').click();const kind=document.querySelector('.predicate-expression select[name=predicateKind]');kind.value='any';kind.dispatchEvent(new Event('change',{bubbles:true}));const child=document.querySelector('.predicate-node .predicate-node select[name=predicateKind]');child.value='between';child.dispatchEvent(new Event('change',{bubbles:true}));
   for(const [name,value] of Object.entries({expression:'1',begin:'0',end:'2'})){const input=document.querySelector('.predicate-node [name='+name+']');input.value=value;input.dispatchEvent(new Event('input',{bubbles:true}));}document.querySelector('.predicate-expression').requestSubmit();`);
  await until(()=>client.evaluate('document.getElementById("query-text").textContent.includes("BETWEEN 0 AND 2")'),'structured group accepted');await ready(client);
  await client.evaluate('document.querySelector("[data-section=conditions] .move-predicate").click()');
  await until(()=>client.evaluate('document.getElementById("query-text").textContent.includes("HAVING")'),'explicit move accepted');await ready(client);
  const text=await client.evaluate('document.getElementById("query-text").textContent');assert.ok(!text.includes('WHERE'));
  await client.evaluate('document.querySelector("header button").click()');client.close();client=undefined;
  await until(()=>draft.getText()===text,'applied predicate draft');await vscode.commands.executeCommand('undo');assert.equal(draft.getText(),before);await vscode.commands.executeCommand('redo');assert.equal(draft.getText(),text);assert.deepEqual(await fs.readFile(f.module),disk);
  await fs.writeFile(path.join(f.root,'host-result.json'),JSON.stringify({passed:true,suite:'query-predicates',locale:vscode.env.language,accepted:['group-kind-and-between-input','explicit-where-having-move','single-undo-redo','source-unchanged']}));
 }finally{client?.close();}
};
