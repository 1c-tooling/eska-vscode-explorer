const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const vscode = require('vscode');
const {connect} = require('./query-constructor-dom.cjs');
const {until, openQuery} = require('./query-modal-host.cjs');
const {ready} = require('./query-builder-host.cjs');

/** Use the public renderer's text menu and native input events throughout the private edit lifecycle. */
async function edit(client, text) {
  await client.evaluate('document.querySelector(".text-tools").open=true;document.querySelector(".edit-query-text").click()');
  if (text !== undefined) await client.evaluate(`{const input=document.querySelector('[name=queryTextBuffer]');input.value=${JSON.stringify(text)};input.dispatchEvent(new Event('input',{bubbles:true}));}`);
}

/** Linked text remains a private, revision-bound buffer until accepted, with native Undo after returning. */
exports.run = async function () {
  const fixture = JSON.parse(process.env.ESKA_HOST_FIXTURE), accepted = [];
  let client;
  try {
    await vscode.extensions.all.find(value => value.packageJSON.name === 'eska-explorer').activate();
    await vscode.commands.executeCommand('eska.explorer.restart');
    const disk = await fs.readFile(fixture.module), draft = await openQuery(vscode.Uri.file(fixture.module)), before = draft.getText();
    await vscode.commands.executeCommand('eska.explorer.queryConstructor', draft.uri);
    client = await connect(until); await ready(client);
    assert.equal(await client.evaluate('getComputedStyle(document.getElementById("root")).display'), 'flex');
    await client.evaluate('document.querySelector("[data-section=fields] tbody input").click();globalThis.previousCopy=document.querySelector("[data-section=fields] .copy-selected");document.querySelector("[data-section=fields] .show-in-text").click()');
    await until(() => client.evaluate('!!document.querySelector("#query-text mark")'), 'selected item highlighted'); await ready(client);
    assert.match(await client.evaluate('document.querySelector("#query-text mark").textContent'), /1 AS A/);
    await client.evaluate('{const text=document.getElementById("query-text"),node=text.lastChild,offset=node.textContent.indexOf("2 AS B");window.getSelection().collapse(node,offset);text.dispatchEvent(new MouseEvent("dblclick",{bubbles:true}));}');
    await until(() => client.evaluate('document.querySelector("[data-section=fields] tr[aria-selected=true]")?.dataset.item==="1"'), 'raw UTF-16 offset selects model row'); await ready(client);
    assert.match(await client.evaluate('document.querySelector("#query-text mark").textContent'), /2 AS B/);
    await client.evaluate('document.querySelector(".text-tools").open=true;document.querySelector(".query-comments").click()');
    await until(() => client.evaluate('!!document.querySelector(".query-comment")'), 'core comment list'); await ready(client);
    assert.match(await client.evaluate('document.querySelector(".query-comment").textContent'), /field B 😀/);
    await client.evaluate('document.querySelector(".query-comment").click()');
    await until(() => client.evaluate('document.querySelector("#query-text mark")?.textContent.includes("field B 😀")'), 'comment range highlighted'); await ready(client);
    assert.equal(await client.evaluate('document.querySelector("[data-section=fields] tr[aria-selected=true]").dataset.item'), '1');
    await client.evaluate('document.querySelector(".comments-close").click()'); await ready(client);
    accepted.push('core-item-comment-and-unicode-ranges');

    await edit(client, 'SELECT 1 +');
    assert.equal(await client.evaluate('[...document.querySelectorAll("#root > :not(.text-editor)")].every(node=>node.inert)'), true);
    assert.equal(await client.evaluate('[...document.querySelectorAll(".text-editor textarea,.text-editor button")].every(node=>{const r=node.getBoundingClientRect();return r.width>0&&r.height>0&&r.top>=0&&r.bottom<=innerHeight&&(node.tagName!=="BUTTON"||r.height<60);})'), true);
    if(process.env.ESKA_HOST_DOM_ARTIFACTS){await fs.mkdir(process.env.ESKA_HOST_DOM_ARTIFACTS,{recursive:true});await client.screenshot(path.join(process.env.ESKA_HOST_DOM_ARTIFACTS,`text-editor-${vscode.env.language}.png`));}
    await client.evaluate('document.querySelector(".text-editor").requestSubmit()');
    await until(() => client.evaluate('!!document.querySelector("[role=alert]")'), 'invalid text rejected'); await ready(client);
    assert.equal(await client.evaluate('document.querySelector("[name=queryTextBuffer]").value'), 'SELECT 1 +');
    assert.equal(await client.evaluate('document.getElementById("query-text").textContent'), before);
    const changed = before.replace('2 AS B', '3 AS B');
    await client.evaluate(`{const input=document.querySelector('[name=queryTextBuffer]');input.value=${JSON.stringify(changed)};input.dispatchEvent(new Event('input',{bubbles:true}));document.querySelector('.text-editor').requestSubmit();}`);
    await until(() => client.evaluate('!!document.querySelector(".action-preview")'), 'text preview'); await ready(client);
    assert.equal(await client.evaluate('document.querySelector(".text-editor").inert'), true);
    assert.equal(await client.evaluate('document.getElementById("query-text").textContent'), before);
    await client.evaluate('document.querySelector(".preview-cancel").click()');
    await until(() => client.evaluate('!document.querySelector(".action-preview")'), 'preview cancelled'); await ready(client);
    assert.equal(await client.evaluate('document.querySelector("[name=queryTextBuffer]").value'), changed.replaceAll('\r\n', '\n'));
    await client.evaluate('document.querySelector(".text-editor").requestSubmit()');
    await until(() => client.evaluate('!!document.querySelector(".action-preview")'), 'repeated text preview'); await ready(client);
    await client.evaluate('document.querySelector(".preview-accept").click()');
    await until(() => client.evaluate('!document.querySelector(".action-preview")&&!document.querySelector(".text-editor")&&document.getElementById("query-text").textContent.includes("3 AS B")'), 'text atomically accepted'); await ready(client);
    assert.equal(await client.evaluate('document.getElementById("query-text").textContent'), changed);
    await client.evaluate('previousCopy.click()'); await ready(client);
    assert.equal(await client.evaluate('document.getElementById("query-text").textContent'), changed);
    accepted.push('invalid-buffer-kept-preview-cancel-parent-inert-accept-stale-button');

    await client.evaluate('document.querySelector(".text-tools").open=true;document.querySelector(".query-diff").click()');
    await until(() => client.evaluate('!!document.querySelector(".action-preview")'), 'diff from constructor opening'); await ready(client);
    assert.deepEqual(await client.evaluate('[...document.querySelectorAll(".preview-diff mark")].map(node=>node.textContent)'), ['2', '3']);
    await client.evaluate('document.querySelector(".diff-close").click()');
    await until(() => client.evaluate('!document.querySelector(".action-preview")'), 'diff closed'); await ready(client);
    await edit(client); await client.evaluate('document.querySelector(".text-cancel").click()');
    assert.equal(await client.evaluate('document.getElementById("query-text").textContent'), changed);
    await client.evaluate('document.querySelector("header button").click()'); client.close(); client = undefined;
    await until(() => draft.getText() === changed, 'one text edit returned to native draft');
    await vscode.commands.executeCommand('undo'); assert.equal(draft.getText(), before);
    await vscode.commands.executeCommand('redo'); assert.equal(draft.getText(), changed);
    assert.deepEqual(await fs.readFile(fixture.module), disk);
    accepted.push('opening-diff-private-cancel-native-undo-redo-owner-unchanged');
    await fs.writeFile(path.join(fixture.root, 'host-result.json'), JSON.stringify({passed:true,suite:'query-text',locale:vscode.env.language,accepted}));
  } catch (error) {
    const dom=client?await client.evaluate('({busy:document.getElementById("root")?.getAttribute("aria-busy"),alerts:[...document.querySelectorAll("[role=alert]")].map(node=>node.textContent),text:document.getElementById("query-text")?.innerHTML,selected:[...document.querySelectorAll("tr[aria-selected=true]")].map(node=>node.dataset.item),button:document.querySelector(".show-in-text")?.outerHTML})').catch(()=>null):null;
    const detail=String(error.stack??error)+' '+JSON.stringify(dom);
    await fs.writeFile(path.join(fixture.root, 'host-result.json'), JSON.stringify({passed:false,suite:'query-text',accepted,error:detail})); throw error;
  } finally { client?.close(); }
};
