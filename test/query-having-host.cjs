const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const vscode = require('vscode');
const { connect } = require('./query-constructor-dom.cjs');
const { until, parentTabs, returned } = require('./query-modal-host.cjs');
const { ready, form } = require('./query-builder-host.cjs');

/** A native typed condition reaches ESKA before another DOM intention is issued. */
async function addFilter(client, kind, values) {
  await client.evaluate(`document.getElementById('tab-conditions').click();document.querySelector('[data-section="${kind}"] .action-add').click()`);
  await form(client, values);
}

/** The installed UI separates WHERE/HAVING and hands off one undoable draft transaction in either locale. */
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
    await addFilter(client, 'having', { left: 'SUM(1)', comparison: 'greater', right: '0' });
    await client.evaluate('document.querySelectorAll("header button")[1].click()'); client.close(); client = undefined;
    await until(() => !vscode.window.tabGroups.all.some(group => group.tabs.some(tab => tab.input instanceof vscode.TabInputWebview)) && vscode.window.activeTextEditor?.document.uri.toString() === draft.uri.toString(), 'HAVING cancel');
    assert.equal(draft.getText(), before);
    await vscode.commands.executeCommand('eska.explorer.queryConstructor', draft.uri); client = await connect(until);
    await client.evaluate('document.querySelector("[data-section=fields] .controls button").click()'); await form(client, { expression: '1', alias: 'Value', aggregate: 'sum' });
    await addFilter(client, 'having', { left: 'SUM(1)', comparison: 'greater', right: '0' });
    await addFilter(client, 'conditions', { left: '1', right: '1' });
    const text = await client.evaluate('document.querySelector(".query-preview pre").textContent');
    assert.ok(text.includes('SUM(1) AS Value')); assert.ok(text.includes('WHERE 1 = 1')); assert.ok(text.includes('HAVING SUM(1) > 0'));
    assert.ok(text.indexOf('WHERE') < text.indexOf('HAVING'));
    assert.equal(await client.evaluate('document.querySelector("[data-section=having] h2").textContent'), vscode.env.language === 'ru' ? 'Отбор по агрегатам (ИМЕЮЩИЕ)' : 'Aggregate filters (HAVING)');
    assert.equal(draft.getText(), before); assert.equal(parentTabs(uri).length, 0);
    if (process.env.ESKA_HOST_DOM_ARTIFACTS) { await fs.mkdir(process.env.ESKA_HOST_DOM_ARTIFACTS, { recursive: true }); await client.screenshot(path.join(process.env.ESKA_HOST_DOM_ARTIFACTS, `query-having-${vscode.env.language}.png`)); }
    await client.evaluate('document.querySelector("header button").click()'); client.close(); client = undefined;
    await until(() => vscode.window.activeTextEditor?.document.uri.toString() === draft.uri.toString() && draft.getText() === text, 'HAVING apply');
    await vscode.commands.executeCommand('undo'); assert.equal(draft.getText(), before); await vscode.commands.executeCommand('redo'); assert.equal(draft.getText(), text);
    await vscode.commands.executeCommand('eska.explorer.applyQuery', draft.uri); const updated = await returned(uri);
    assert.ok(updated.getText().includes('HAVING')); assert.deepEqual(await fs.readFile(fixture.module), disk);
    await vscode.commands.executeCommand('undo'); assert.equal(updated.getText(), original);
    accepted.push('separate_typed_where_having_cancel_apply_undo_redo_and_unchanged_owner_bytes');
    await fs.writeFile(path.join(fixture.root, 'host-result.json'), JSON.stringify({ passed: true, suite: 'query-having', locale: vscode.env.language, accepted }));
  } catch (error) { await fs.writeFile(path.join(fixture.root, 'host-result.json'), JSON.stringify({ passed: false, suite: 'query-having', error: String(error.stack ?? error), accepted })); throw error; }
  finally { client?.close(); }
};
