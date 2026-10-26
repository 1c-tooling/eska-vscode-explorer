const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const vscode = require('vscode');
const { connect } = require('./query-constructor-dom.cjs');
const { until, parentTabs, returned } = require('./query-modal-host.cjs');

/** Native model publications acknowledge asynchronous DOM intentions before the next user action. */
async function ready(client) {
  await until(() => client.evaluate('document.getElementById("root").getAttribute("aria-busy") === "false"'), 'visual operation acknowledged');
}

/** Fill ordinary form controls through real browser events; no direct webview messages bypass the renderer. */
async function form(client, values) {
  await client.evaluate(`for (const [key,value] of Object.entries(${JSON.stringify(values)})) {
    const input = document.querySelector('.expression [name="'+key+'"]'); if (!input) throw Error(key);
    input.value=value; input.dispatchEvent(new Event(input.tagName==='SELECT'?'change':'input',{bubbles:true}));
  } document.querySelector('.expression').requestSubmit();`);
  await until(() => client.evaluate('!document.querySelector(".expression")'), 'form submitted'); await ready(client);
}
exports.ready = ready;
exports.form = form;

/** Select the first row through the current table UI while retaining old-capability acceptance. */
exports.editFirstField = async function(client) {
  await client.evaluate(`{const section=document.querySelector('[data-section=fields]');
    if(section.querySelector('tbody')){section.querySelector('tbody input').click();document.querySelector('[data-section=fields] .edit-selected').click();}
    else section.querySelector('.controls button').click();}`);
};

/** Pick real metadata and a field by actual native-rendered buttons, never through a second catalog or SQL generator. */
async function pick(client) {
  await client.evaluate(`const row=[...document.querySelectorAll('.metadata-table')].find(row=>row.querySelector('.table-name').textContent==='Товары');
    if(!row)throw Error('metadata table'); row.querySelector('.table-add').click();`);
  await until(() => client.evaluate('[...document.querySelectorAll(".source-tree summary")].some(node=>node.textContent==="Товары")'), 'metadata source selected'); await ready(client);
  await client.evaluate(`const field=[...document.querySelectorAll('.field-choice')].find(node=>node.textContent==='Товары.Артикул');
    if(!field)throw Error('metadata field');field.dispatchEvent(new MouseEvent('dblclick',{bubbles:true}));`);
  await until(() => client.evaluate('document.querySelector(".query-preview pre").textContent.includes("Товары.Артикул")'), 'metadata field selected'); await ready(client);
}

/** Exercise all five pages in a normal installed window, including cancellation, native Undo and unchanged disk bytes. */
exports.run = async function () {
  const fixture = JSON.parse(process.env.ESKA_HOST_FIXTURE), accepted = [];
  let client;
  try {
    assert.equal(await vscode.extensions.all.find(value => value.packageJSON.name === 'eska-explorer').activate(), undefined);
    await vscode.commands.executeCommand('eska.explorer.restart');
    const uri = vscode.Uri.file(fixture.module), disk = await fs.readFile(fixture.module);
    const owner = await vscode.workspace.openTextDocument(uri), original = owner.getText();
    const editor = await vscode.window.showTextDocument(owner, { preview: false }), at = owner.positionAt(original.indexOf('SELECT ') + 3);
    editor.selection = new vscode.Selection(at, at); await vscode.commands.executeCommand('eska.explorer.editBslQuery');
    const draft = await until(() => vscode.window.activeTextEditor?.document.uri.scheme === 'eska-query' && vscode.window.activeTextEditor.document, 'query');
    const before = draft.getText(); await vscode.commands.executeCommand('eska.explorer.queryConstructor', draft.uri); client = await connect(until);
    if(process.env.ESKA_EXPECT_CONSTRUCTOR_LEGACY_TOOLS==='1')assert.equal(await client.evaluate('document.querySelectorAll(".query-settings,.text-tools,.item-table").length'),0);
    assert.equal(await client.evaluate('document.querySelectorAll("[role=tab]").length'), Number(process.env.ESKA_EXPECT_CONSTRUCTOR_PAGES ?? 9));
    assert.equal(await client.evaluate('document.querySelector("[role=tab]").textContent'), vscode.env.language === 'ru' ? 'Таблицы и поля' : 'Tables and fields');
    await pick(client);
    await client.evaluate('document.querySelector(".all-fields").click()');
    await until(() => client.evaluate('document.querySelector(".query-preview pre").textContent.includes("Товары.Ref")'), 'Add All acknowledged'); await ready(client);
    assert.equal(await client.evaluate('(document.querySelector(".query-preview pre").textContent.match(/Товары\\.Артикул/g)||[]).length'), 1);
    await client.evaluate('document.querySelectorAll("header button")[1].click()'); client.close(); client = undefined;
    await until(() => !vscode.window.tabGroups.all.some(group => group.tabs.some(tab => tab.input instanceof vscode.TabInputWebview))
      && vscode.window.activeTextEditor?.document.uri.toString() === draft.uri.toString(), 'Cancel returns same draft');
    assert.equal(vscode.window.activeTextEditor.document.getText(), before);
    accepted.push('real_metadata_tables_fields_add_all_and_cancel_without_source_mutation');
    await vscode.commands.executeCommand('eska.explorer.queryConstructor', draft.uri); client = await connect(until); await pick(client);
    for (const [tab, section, values] of [
      ['joins', 'joins', { table: 'Catalog.Покупатели', alias: 'П', left: 'Товары.Ref', right: 'Ref' }],
      ['conditions', 'conditions', { left: 'Товары.Артикул', right: '&Article' }],
      ['group', 'group', { expression: 'Товары.Артикул' }],
      ['group', 'fields', { expression: '1', alias: 'Counted', aggregate: 'sum' }],
      ['order', 'order', { expression: 'Товары.Артикул', descending: 'yes' }],
    ]) {
      await client.evaluate(`document.getElementById('tab-${tab}').click();document.querySelector('[data-section="${section}"] .action-add').click();`);
      await form(client, values);
    }
    const text = await client.evaluate('document.querySelector(".query-preview pre").textContent');
    for (const part of ['LEFT JOIN Catalog.Покупатели AS П ON Товары.Ref = П.Ref', 'WHERE Товары.Артикул = &Article',
      'GROUP BY Товары.Артикул', 'SUM(1) AS Counted', 'ORDER BY Товары.Артикул DESC']) assert.ok(text.includes(part), part);
    assert.equal(await client.evaluate('document.querySelectorAll("#root img,#root script").length'), 0);
    assert.equal(await client.evaluate('document.body.scrollWidth <= innerWidth'), true);
    accepted.push('five_pages_generate_join_condition_group_aggregate_and_direction_through_eska');
    if (process.env.ESKA_HOST_DOM_ARTIFACTS) {
      await fs.mkdir(process.env.ESKA_HOST_DOM_ARTIFACTS, { recursive: true });
      await client.evaluate('document.getElementById("tab-tablesFields").click()');
      await client.screenshot(path.join(process.env.ESKA_HOST_DOM_ARTIFACTS, `query-builder-${vscode.env.language}.png`));
    }
    await client.evaluate('document.querySelector("header button").click()'); client.close(); client = undefined;
    const changed = await until(() => vscode.window.activeTextEditor?.document.uri.toString() === draft.uri.toString()
      && vscode.window.activeTextEditor.document.getText().includes('Counted') && vscode.window.activeTextEditor.document, 'Apply returns same query');
    assert.equal(changed.getText(), text); assert.equal(parentTabs(uri).length, 0);
    await vscode.commands.executeCommand('undo'); assert.equal(changed.getText(), before);
    await vscode.commands.executeCommand('redo'); assert.equal(changed.getText(), text);
    await vscode.commands.executeCommand('eska.explorer.applyQuery', changed.uri);
    const updated = await returned(uri); assert.ok(updated.getText().includes('Counted')); assert.equal(updated.isDirty, true);
    assert.deepEqual(await fs.readFile(fixture.module), disk); await vscode.commands.executeCommand('undo'); assert.equal(updated.getText(), original);
    accepted.push('same_draft_native_undo_redo_modal_return_and_unsaved_owner_single_undo');
    await fs.writeFile(path.join(fixture.root, 'host-result.json'), JSON.stringify({ passed: true, suite: 'query-builder', locale: vscode.env.language, accepted }));
  } catch (error) {
    await fs.writeFile(path.join(fixture.root, 'host-result.json'), JSON.stringify({ passed: false, suite: 'query-builder', error: String(error.stack ?? error), accepted })); throw error;
  } finally { client?.close(); }
};
