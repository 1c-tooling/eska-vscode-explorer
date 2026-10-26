const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const path=require('node:path');
const vscode=require('vscode');
const {connect}=require('./query-constructor-dom.cjs');
const {until,openQuery}=require('./query-modal-host.cjs');
const {ready,form,editFirstField}=require('./query-builder-host.cjs');

/** A real large application remains editable through core metadata when its optional analyzer is unavailable. */
exports.run=async function(){
  const fixture=JSON.parse(process.env.ESKA_HOST_FIXTURE),module=process.env.ESKA_COMPACT_BUHMFO_MODULE;assert.ok(path.isAbsolute(module));let client;
  try{
    await vscode.extensions.all.find(value=>value.packageJSON.name==='eska-explorer').activate();
    await vscode.commands.executeCommand('eska.explorer.restart');
    const disk=await fs.readFile(module),draft=await openQuery(vscode.Uri.file(module)),before=draft.getText();
    await vscode.commands.executeCommand('eska.explorer.queryConstructor',draft.uri);client=await connect(until);await ready(client);
    await until(()=>client.evaluate('[...document.querySelectorAll(".field-choice")].some(node=>node.textContent==="Орг.ИНН")'),'inherited field in native large application');
    await editFirstField(client);await form(client,{expression:'Орг.ИНН',alias:'ИНН'});
    await until(()=>client.evaluate('document.getElementById("query-text").textContent.includes("Орг.ИНН AS ИНН")'),'large application field edit');await ready(client);
    const changed=await client.evaluate('document.getElementById("query-text").textContent');
    await client.evaluate('document.querySelector(".text-tools").open=true;document.querySelector(".query-diff").click()');
    await until(()=>client.evaluate('!!document.querySelector(".action-preview")'),'large application diff');await ready(client);
    assert.equal(await client.evaluate('document.querySelector(".preview-diff").textContent.includes("Орг.ИНН")'),true);
    await client.evaluate('document.querySelector(".diff-close").click()');await until(()=>client.evaluate('!document.querySelector(".action-preview")'),'diff closed');await ready(client);
    await client.evaluate('document.querySelectorAll("header button")[1].click()');client.close();client=undefined;
    await until(()=>vscode.window.activeTextEditor?.document.uri.toString()===draft.uri.toString(),'cancel large constructor');
    assert.equal(vscode.window.activeTextEditor.document.getText(),before);assert.notEqual(changed,before);assert.deepEqual(await fs.readFile(module),disk);
    assert.equal(vscode.workspace.getConfiguration('eska.explorer').get('languageFeatures'),true);
    await assert.rejects(fs.stat(vscode.workspace.getConfiguration('eska.explorer').get('analyzerExecutable')),{code:'ENOENT'});
    await vscode.commands.executeCommand('eska.explorer.cancelQuery',draft.uri);
    await fs.writeFile(path.join(fixture.root,'host-result.json'),JSON.stringify({passed:true,suite:'query-buhmfo-constructor',locale:vscode.env.language,analyzer:'configured-but-unavailable',accepted:['large-application-and-five-extensions','inherited-field-ui','core-field-edit','opening-diff','cancel-owner-unchanged']}));
  }finally{client?.close();}
};
