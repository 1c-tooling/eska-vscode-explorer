const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const vscode = require('vscode');
const { connect } = require('./query-constructor-dom.cjs');
const { until, parentTabs, returned } = require('./query-modal-host.cjs');
const { ready, form } = require('./query-builder-host.cjs');

/** A package property changes only through ordinary DOM input and submit events. */
async function destination(client, name) {
  await client.evaluate(`{document.getElementById('tab-packages').click();const input=document.querySelector('.temporary-destination input');
    input.value=${JSON.stringify(name)};input.dispatchEvent(new Event('input',{bubbles:true}));document.querySelector('.temporary-destination').requestSubmit();}`);
  await until(() => client.evaluate(`document.querySelector('.query-preview pre').textContent.includes(${JSON.stringify('INTO ' + name)})`), 'destination acknowledged');
  await ready(client);
}

/** The installed extension uses backend package scopes, real table choices and native Undo/Redo without changing disk bytes. */
exports.run = async function () {
  const fixture = JSON.parse(process.env.ESKA_HOST_FIXTURE), accepted = [];
  let client;
  try {
    await vscode.extensions.all.find(value => value.packageJSON.name === 'eska-explorer').activate();
    await vscode.commands.executeCommand('eska.explorer.restart');
    const uri = vscode.Uri.file(fixture.module), disk = await fs.readFile(fixture.module), owner = await vscode.workspace.openTextDocument(uri), original = owner.getText();
    const editor = await vscode.window.showTextDocument(owner, { preview: false }), at = owner.positionAt(original.indexOf('SELECT ') + 3);
    editor.selection = new vscode.Selection(at, at); await vscode.commands.executeCommand('eska.explorer.editBslQuery');
    const draft = await until(() => vscode.window.activeTextEditor?.document.uri.scheme === 'eska-query' && vscode.window.activeTextEditor.document, 'query'), before = draft.getText();
    await vscode.commands.executeCommand('eska.explorer.queryConstructor', draft.uri); client = await connect(until);
    await destination(client, 'Cancelled');
    await client.evaluate('document.querySelectorAll("header button")[1].click()'); client.close(); client = undefined;
    await until(() => !vscode.window.tabGroups.all.some(group => group.tabs.some(tab => tab.input instanceof vscode.TabInputWebview))
      && vscode.window.activeTextEditor?.document.uri.toString() === draft.uri.toString(), 'cancel closes panel and returns draft');
    assert.equal(draft.getText(), before); accepted.push('package_cancel_keeps_same_draft');
    await vscode.commands.executeCommand('eska.explorer.queryConstructor', draft.uri); client = await connect(until);
    await destination(client, 'Temp');
    await client.evaluate('document.querySelector(".add-statement").click()');
    await until(() => client.evaluate('document.querySelectorAll(".package-settings > .row").length === 2'), 'second package operator'); await ready(client);
    await client.evaluate(`document.getElementById('tab-tablesFields').click();const row=[...document.querySelectorAll('.metadata-table')].find(row=>row.querySelector('.table-name').textContent==='Temp');
      if(!row)throw Error('temporary catalog');row.querySelector('.table-add').click();`);
    await until(() => client.evaluate('!!document.querySelector(".source-tree .field-choice")'), 'temporary fields'); await ready(client);
    assert.equal(await client.evaluate('[...document.querySelectorAll(".field-choice")].some(node=>node.textContent==="Temp.Value")'), true);
    await client.evaluate('document.querySelector("[data-section=fields] .controls button").click()');
    await form(client, { expression: 'Temp.Value', alias: 'Value' });
    await client.evaluate('document.getElementById("tab-packages").click();document.querySelector(".package-settings > .row button").click()');
    await until(() => client.evaluate('document.querySelector(".temporary-destination input")?.value === "Temp"'), 'producer selected'); await ready(client);
    await destination(client, 'Renamed');
    assert.equal(await client.evaluate('document.querySelector(".query-preview pre").textContent.includes("FROM Renamed AS Temp")'), true);
    assert.equal(await client.evaluate('document.querySelector(".query-preview pre").textContent.includes("Temp.Value AS Value")'), true);
    accepted.push('temporary_catalog_projection_and_atomic_rename_preserve_explicit_alias');
    await client.evaluate('document.querySelectorAll(".package-settings > .row")[1].querySelector("button").click()');
    await until(() => client.evaluate('document.querySelector(".temporary-destination input")?.value === ""'), 'consumer selected'); await ready(client);
    await client.evaluate(`{const input=document.querySelector('.temporary-drop input');input.value='Renamed';input.dispatchEvent(new Event('input',{bubbles:true}));document.querySelector('.temporary-drop').requestSubmit();}`);
    await until(() => client.evaluate('document.querySelector(".query-preview pre").textContent.includes("DESTROY Renamed")'), 'destroy operator'); await ready(client);
    const text = await client.evaluate('document.querySelector(".query-preview pre").textContent');
    assert.equal(draft.getText(), before); assert.equal(parentTabs(uri).length, 0); assert.deepEqual(await fs.readFile(fixture.module), disk);
    assert.equal(await client.evaluate('document.body.scrollWidth <= innerWidth'), true);
    if (process.env.ESKA_HOST_DOM_ARTIFACTS) {
      await fs.mkdir(process.env.ESKA_HOST_DOM_ARTIFACTS, { recursive: true });
      await client.screenshot(path.join(process.env.ESKA_HOST_DOM_ARTIFACTS, `query-package-${vscode.env.language}.png`));
    }
    await client.evaluate('document.querySelector("header button").click()'); client.close(); client = undefined;
    await until(() => vscode.window.activeTextEditor?.document.uri.toString() === draft.uri.toString() && draft.getText() === text, 'package applied');
    await vscode.commands.executeCommand('undo'); assert.equal(draft.getText(), before);
    await vscode.commands.executeCommand('redo'); assert.equal(draft.getText(), text);
    await vscode.commands.executeCommand('eska.explorer.applyQuery', draft.uri);
    const updated = await returned(uri); assert.equal(updated.isDirty, true); assert.ok(updated.getText().includes('DESTROY Renamed'));
    assert.deepEqual(await fs.readFile(fixture.module), disk); await vscode.commands.executeCommand('undo'); assert.equal(updated.getText(), original);
    accepted.push('package_apply_native_undo_redo_and_parent_single_undo_preserve_disk');
    await fs.writeFile(path.join(fixture.root, 'host-result.json'), JSON.stringify({ passed: true, suite: 'query-package', locale: vscode.env.language, accepted }));
  } catch (error) {
    await fs.writeFile(path.join(fixture.root, 'host-result.json'), JSON.stringify({ passed: false, suite: 'query-package', error: String(error.stack ?? error), accepted })); throw error;
  } finally { client?.close(); }
};
