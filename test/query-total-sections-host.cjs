const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const vscode = require('vscode');
const { connect } = require('./query-constructor-dom.cjs');
const { until, parentTabs, returned } = require('./query-modal-host.cjs');
const { ready, form } = require('./query-builder-host.cjs');

/** Add a section through the installed control and wait for its acknowledged picker. */
async function addSection(client, count) {
  await client.evaluate('document.getElementById("tab-totals").click();document.querySelector(".add-total-section").click()');
  await until(() => client.evaluate(`document.querySelectorAll('.total-sections select option').length === ${count}`), 'totals section added'); await ready(client);
}

/** The expression controls send values only; the real backend owns the selected section and SQL generation. */
async function totalField(client, aggregate) {
  await client.evaluate('document.querySelector("[data-section=totals] .action-add").click()'); await form(client, { expression: 'Value', aggregate });
}

/** Section selection is UI state over backend-provided clause references, with no query parsing. */
async function selectSection(client, index) {
  await client.evaluate(`{const picker=document.querySelector('.total-sections select');picker.value='${index}';picker.dispatchEvent(new Event('change',{bubbles:true}));}`); await ready(client);
}

/** The normal installed extension edits several sections, cancels, applies and preserves native owner/draft undo boundaries. */
exports.run = async function () {
  const fixture = JSON.parse(process.env.ESKA_HOST_FIXTURE), accepted = [];
  let client;
  try {
    await vscode.extensions.all.find(value => value.packageJSON.name === 'eska-explorer').activate(); await vscode.commands.executeCommand('eska.explorer.restart');
    const uri = vscode.Uri.file(fixture.module), disk = await fs.readFile(fixture.module), owner = await vscode.workspace.openTextDocument(uri), original = owner.getText();
    const editor = await vscode.window.showTextDocument(owner, { preview: false }), at = owner.positionAt(original.indexOf('SELECT ') + 3);
    editor.selection = new vscode.Selection(at, at); await vscode.commands.executeCommand('eska.explorer.editBslQuery');
    const draft = await until(() => vscode.window.activeTextEditor?.document.uri.scheme === 'eska-query' && vscode.window.activeTextEditor.document, 'draft'), before = draft.getText();
    await vscode.commands.executeCommand('eska.explorer.queryConstructor', draft.uri); client = await connect(until); await addSection(client, 1);
    await client.evaluate('document.querySelectorAll("header button")[1].click()'); client.close(); client = undefined;
    await until(() => !vscode.window.tabGroups.all.some(group => group.tabs.some(tab => tab.input instanceof vscode.TabInputWebview)) && vscode.window.activeTextEditor?.document.uri.toString() === draft.uri.toString(), 'totals cancel'); assert.equal(draft.getText(), before);
    await vscode.commands.executeCommand('eska.explorer.queryConstructor', draft.uri); client = await connect(until);
    await addSection(client, 1); await totalField(client, 'sum'); await addSection(client, 2); await totalField(client, 'maximum');
    await selectSection(client, 0); assert.equal(await client.evaluate('document.querySelector("[data-section=totals]").textContent.includes("MAX(")'), false);
    await selectSection(client, 1);
    const selectedSection = await client.evaluate('({picker:document.querySelector(".total-sections select").value,rows:document.querySelector("[data-section=totals]").textContent,text:document.querySelector(".query-preview pre").textContent})');
    assert.equal(selectedSection.rows.includes("MAX("), true, JSON.stringify(selectedSection));
    await client.evaluate('document.querySelector(".total-section-moveUp").click()');
    await until(() => client.evaluate(`{const text=document.querySelector('.query-preview pre').textContent;text.indexOf('MAX(')<text.indexOf('SUM(')}`), 'paired section moved'); await ready(client);
    assert.equal(await client.evaluate('document.querySelector(".total-sections select").value'), '0');
    await client.evaluate('document.querySelector(".remove-total-section").click()');
    await until(() => client.evaluate('document.querySelectorAll(".total-sections select option").length === 1'), 'one section removed'); await ready(client);
    assert.equal(await client.evaluate('document.querySelector(".query-preview pre").textContent.includes("MAX(")'), false);
    await addSection(client, 2); await totalField(client, 'maximum');
    const text = await client.evaluate('document.querySelector(".query-preview pre").textContent'); assert.equal((text.match(/TOTALS/g) || []).length, 2);
    assert.equal(draft.getText(), before); assert.equal(parentTabs(uri).length, 0); assert.deepEqual(await fs.readFile(fixture.module), disk);
    if (process.env.ESKA_HOST_DOM_ARTIFACTS) { await fs.mkdir(process.env.ESKA_HOST_DOM_ARTIFACTS, { recursive: true }); await client.screenshot(path.join(process.env.ESKA_HOST_DOM_ARTIFACTS, `query-total-sections-${vscode.env.language}.png`)); }
    await client.evaluate('document.querySelector("header button").click()'); client.close(); client = undefined;
    await until(() => vscode.window.activeTextEditor?.document.uri.toString() === draft.uri.toString() && draft.getText() === text, 'totals apply');
    await vscode.commands.executeCommand('undo'); assert.equal(draft.getText(), before); await vscode.commands.executeCommand('redo'); assert.equal(draft.getText(), text);
    await vscode.commands.executeCommand('eska.explorer.applyQuery', draft.uri); const updated = await returned(uri); assert.ok(updated.getText().includes('MAX('));
    assert.deepEqual(await fs.readFile(fixture.module), disk); await vscode.commands.executeCommand('undo'); assert.equal(updated.getText(), original);
    accepted.push('independent_total_sections_add_select_move_remove_cancel_apply_and_native_undo_redo');
    await fs.writeFile(path.join(fixture.root, 'host-result.json'), JSON.stringify({ passed: true, suite: 'query-total-sections', locale: vscode.env.language, accepted }));
  } catch (error) { await fs.writeFile(path.join(fixture.root, 'host-result.json'), JSON.stringify({ passed: false, suite: 'query-total-sections', error: String(error.stack ?? error), accepted })); throw error; }
  finally { client?.close(); }
};
