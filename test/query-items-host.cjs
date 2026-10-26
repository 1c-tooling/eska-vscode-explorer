const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const vscode = require('vscode');
const {connect} = require('./query-constructor-dom.cjs');
const {until,openQuery} = require('./query-modal-host.cjs');
const {ready} = require('./query-builder-host.cjs');

/** Exercise atomic item intentions in an installed editor and its native Undo stack. */
exports.run = async function () {
  const fixture=JSON.parse(process.env.ESKA_HOST_FIXTURE), disk=await fs.readFile(fixture.module);
  let client;
  try {
    await vscode.extensions.all.find(value=>value.packageJSON.name==='eska-explorer').activate();
    await vscode.commands.executeCommand('eska.explorer.restart');
    const draft=await openQuery(vscode.Uri.file(fixture.module)), before=draft.getText();
    await vscode.commands.executeCommand('eska.explorer.queryConstructor',draft.uri);client=await connect(until);await ready(client);
    const rows=()=>client.evaluate('document.querySelectorAll("[data-section=fields] tbody tr").length');
    assert.equal(await rows(),2);
    const layoutReview = {};
    await client.evaluate('document.querySelector("[data-section=fields] thead input").click()');
    layoutReview.selectAll = await client.evaluate('[...document.querySelectorAll("[data-section=fields] tbody tr")].map(row=>({selected:row.getAttribute("aria-selected"),checked:row.querySelector("input").checked}))');
    await client.evaluate('document.querySelector("[data-section=fields] thead input").click();document.querySelector("[data-section=fields] tbody input").click();document.querySelector("[data-section=fields] .edit-selected").click();{const input=document.querySelector(".expression [name=expression]");input.value="999";input.dispatchEvent(new Event("input",{bubbles:true}));}');
    await client.evaluate('document.querySelectorAll("[data-section=fields] tbody input")[0].click();document.querySelectorAll("[data-section=fields] tbody input")[1].click();document.querySelector("[data-section=fields] .edit-selected").click()');
    layoutReview.otherExpression = await client.evaluate('document.querySelector(".expression [name=expression]").value');
    await fs.writeFile(path.join(fixture.root,'layout-review.json'),JSON.stringify(layoutReview));
    if(process.env.ESKA_REVIEW_OUTPUT)await fs.writeFile(process.env.ESKA_REVIEW_OUTPUT,JSON.stringify(layoutReview));
    assert.deepEqual(layoutReview.selectAll,[{selected:'true',checked:true},{selected:'true',checked:true}]);
    assert.equal(layoutReview.otherExpression,'2','another row must not inherit unsaved input');
    await client.evaluate('document.querySelector(".expression [data-action=submit] + button").click();document.querySelectorAll("[data-section=fields] tbody input")[1].click()');
    await client.evaluate('document.querySelector("[data-section=fields] tbody input").click();document.querySelector("[data-section=fields] .copy-selected").click()');
    await until(async()=>await rows()===3,'copied selected row');await ready(client);
    assert.match(await client.evaluate('document.getElementById("query-text").textContent'),/AS A2/);
    assert.equal(await client.evaluate('document.querySelectorAll("[data-section=fields] tr[aria-selected=true]").length'),1);
    await client.evaluate('document.querySelector("[data-section=fields] .move-selected-up").click()');await ready(client);
    await until(()=>client.evaluate('document.querySelector("[data-section=fields] tr[aria-selected=true]").dataset.item==="1"'),'moved copied row');
    await client.evaluate('document.querySelector("[data-section=fields] tr[aria-selected=true] .cell-value").dispatchEvent(new MouseEvent("dblclick",{bubbles:true}));const input=document.querySelector("[name=cell-expression]");input.value="42";input.dispatchEvent(new Event("input",{bubbles:true}));input.dispatchEvent(new KeyboardEvent("keydown",{key:"Enter",bubbles:true}));');
    await until(()=>client.evaluate('document.getElementById("query-text").textContent.includes("42 AS A2")'),'inline expression committed');await ready(client);
    await client.evaluate('document.querySelector("[data-section=fields] thead input").click()');
    assert.equal(await client.evaluate('document.querySelectorAll("[data-section=fields] tr[aria-selected=true]").length'),3);
    const snapshot=await client.evaluate('document.getElementById("query-text").textContent');
    await client.evaluate('document.querySelector("[data-section=fields] .remove-selected").click()');await ready(client);
    await until(()=>client.evaluate('!!document.querySelector("[role=alert]")'),'required fields rejected');
    assert.equal(await client.evaluate('document.getElementById("query-text").textContent'),snapshot);
    await client.evaluate('document.querySelector("header button").click()');client.close();client=undefined;
    await until(()=>vscode.window.activeTextEditor?.document.uri.toString()===draft.uri.toString() && draft.getText()===snapshot,'applied same draft');
    assert.equal(draft.getText(),snapshot);await vscode.commands.executeCommand('undo');assert.equal(draft.getText(),before);
    await vscode.commands.executeCommand('redo');assert.equal(draft.getText(),snapshot);
    assert.deepEqual(await fs.readFile(fixture.module),disk);
    const report={passed:true,suite:'query-items',locale:vscode.env.language,accepted:['select-copy-core-alias','move-core-focus','inline-cell','select-all-atomic-refusal','apply-native-undo-redo','owner-unchanged']};
    await fs.writeFile(path.join(fixture.root,'host-result.json'),JSON.stringify(report));
  }finally{client?.close();}
};
