const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const vscode = require('vscode');
const { connect } = require('./query-constructor-dom.cjs');
const { until, parentTabs, returned } = require('./query-modal-host.cjs');
const { ready, form } = require('./query-builder-host.cjs');

/** Type only a field value; ESKA owns braces, keywords and alias validation. */
async function addProjection(client) {
  await client.evaluate("document.getElementById('tab-dcs').click();document.querySelector('.dcs-add-select').click()");
  await form(client, { expression: 'Value' });
}

/** The installed UI edits typed DCS lists and hands off one undoable draft transaction in either locale. */
exports.run = async function () {
  const fixture = JSON.parse(process.env.ESKA_HOST_FIXTURE), accepted = [];
  let client;
  try {
    await vscode.extensions.all.find(value => value.packageJSON.name === 'eska-explorer').activate();
    await vscode.commands.executeCommand('eska.explorer.restart');
    const uri = vscode.Uri.file(fixture.module), disk = await fs.readFile(fixture.module), owner = await vscode.workspace.openTextDocument(uri), original = owner.getText();
    const editor = await vscode.window.showTextDocument(owner, { preview: false }), at = owner.positionAt(original.indexOf('SELECT ') + 3);
    editor.selection = new vscode.Selection(at, at); await vscode.commands.executeCommand('eska.explorer.editBslQuery');
    const draft = await until(() => vscode.window.activeTextEditor?.document.uri.scheme === 'eska-query' && vscode.window.activeTextEditor.document, 'draft'), before = draft.getText();
    await vscode.commands.executeCommand('eska.explorer.queryConstructor', draft.uri); client = await connect(until);
    await addProjection(client);
    await client.evaluate('document.querySelectorAll("header button")[1].click()'); client.close(); client = undefined;
    await until(() => !vscode.window.tabGroups.all.some(group => group.tabs.some(tab => tab.input instanceof vscode.TabInputWebview)) && vscode.window.activeTextEditor?.document.uri.toString() === draft.uri.toString(), 'DCS cancel');
    assert.equal(draft.getText(), before);
    await vscode.commands.executeCommand('eska.explorer.queryConstructor', draft.uri); client = await connect(until);
    await addProjection(client);
    await client.evaluate("document.querySelector('.dcs-add-where').click()");
    await form(client, { expression: 'T.Ref' });
    await client.evaluate("document.querySelector('[data-kind=where] .dcs-edit').click();document.querySelector('.dcs-add-condition').click()");
    await form(client, { left: 'T.Ref', comparison: 'equal', right: '&Item' });
    const text = await client.evaluate('document.querySelector(".query-preview pre").textContent');
    assert.ok(text.includes('{SELECT Value}')); assert.ok(text.includes('{WHERE T.Ref, T.Ref = &Item}'));
    assert.equal(await client.evaluate('document.querySelector(".dcs-settings h2").textContent'), vscode.env.language === 'ru' ? 'СКД' : 'Data composition');
    const tab = await client.evaluate('{const r=document.getElementById("tab-dcs").getBoundingClientRect(),p=document.querySelector(".tabs").getBoundingClientRect();({left:r.left,right:r.right,parentLeft:p.left,parentRight:p.right})}');
    assert.ok(tab.left >= tab.parentLeft - 1 && tab.right <= tab.parentRight + 1, JSON.stringify(tab));
    assert.equal(draft.getText(), before); assert.equal(parentTabs(uri).length, 0);
    if (process.env.ESKA_HOST_DOM_ARTIFACTS) { await fs.mkdir(process.env.ESKA_HOST_DOM_ARTIFACTS, { recursive: true }); await client.screenshot(path.join(process.env.ESKA_HOST_DOM_ARTIFACTS, `query-dcs-${vscode.env.language}.png`)); }
    await client.evaluate('document.querySelector("header button").click()'); client.close(); client = undefined;
    await until(() => vscode.window.activeTextEditor?.document.uri.toString() === draft.uri.toString() && draft.getText() === text, 'DCS apply');
    await vscode.commands.executeCommand('undo'); assert.equal(draft.getText(), before); await vscode.commands.executeCommand('redo'); assert.equal(draft.getText(), text);
    await vscode.commands.executeCommand('eska.explorer.applyQuery', draft.uri); const updated = await returned(uri);
    assert.ok(updated.getText().includes('{SELECT Value}')); assert.deepEqual(await fs.readFile(fixture.module), disk);
    await vscode.commands.executeCommand('undo'); assert.equal(updated.getText(), original);
    accepted.push('typed_dcs_lists_cancel_apply_undo_redo_and_unchanged_owner_bytes');
    await fs.writeFile(path.join(fixture.root, 'host-result.json'), JSON.stringify({ passed: true, suite: 'query-dcs', locale: vscode.env.language, accepted }));
  } catch (error) { await fs.writeFile(path.join(fixture.root, 'host-result.json'), JSON.stringify({ passed: false, suite: 'query-dcs', error: String(error.stack ?? error), accepted })); throw error; }
  finally { client?.close(); }
};
