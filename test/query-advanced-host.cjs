const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const vscode = require('vscode');
const { connect } = require('./query-constructor-dom.cjs');
const { until, parentTabs, returned } = require('./query-modal-host.cjs');
const { ready, form, editFirstField } = require('./query-builder-host.cjs');

/** A model-driven operation must reach its acknowledged DOM before the next native action. */
async function textContains(client, value) {
  await until(() => client.evaluate(`document.querySelector('.query-preview pre').textContent.includes(${JSON.stringify(value)})`), value);
  await ready(client);
}

/** The installed normal-mode extension edits all advanced constructs through real DOM controls and production ESKA RPC. */
exports.run = async function () {
  const fixture = JSON.parse(process.env.ESKA_HOST_FIXTURE), accepted = [];
  let client;
  try {
    assert.equal(await vscode.extensions.all.find(value => value.packageJSON.name === 'eska-explorer').activate(), undefined);
    await vscode.commands.executeCommand('eska.explorer.restart');
    const uri = vscode.Uri.file(fixture.module), disk = await fs.readFile(fixture.module), owner = await vscode.workspace.openTextDocument(uri), original = owner.getText();
    const editor = await vscode.window.showTextDocument(owner, { preview: false }), at = owner.positionAt(original.indexOf('SELECT ') + 3);
    editor.selection = new vscode.Selection(at, at); await vscode.commands.executeCommand('eska.explorer.editBslQuery');
    const draft = await until(() => vscode.window.activeTextEditor?.document.uri.scheme === 'eska-query' && vscode.window.activeTextEditor.document, 'query');
    const before = draft.getText(); await vscode.commands.executeCommand('eska.explorer.queryConstructor', draft.uri); client = await connect(until);
    assert.equal(await client.evaluate('document.querySelectorAll("[role=tab]").length'), Number(process.env.ESKA_EXPECT_CONSTRUCTOR_PAGES ?? 9));
    await client.evaluate(`const row=[...document.querySelectorAll('.metadata-table')].find(row=>row.querySelector('.table-name').textContent==='Stock');
      if(!row)throw Error('Stock');row.querySelector('button').click();`);
    await until(() => client.evaluate(`!!document.querySelector('[data-table="AccumulationRegister.Stock.BalanceAndTurnovers"]')`), 'virtual catalog'); await ready(client);
    await client.evaluate(`document.querySelector('[data-table="AccumulationRegister.Stock.BalanceAndTurnovers"]').click()`);
    await until(() => client.evaluate('document.querySelectorAll(".expression [name^=parameter-]").length === 5'), 'positional parameter form'); await ready(client);
    await form(client, { alias: 'S', 'parameter-0': '&Begin', 'parameter-1': '&End', 'parameter-2': 'Month', 'parameter-3': 'RegisterRecords', 'parameter-4': 'Item = &Item' });
    await textContains(client, 'BalanceAndTurnovers(&Begin, &End, Month, RegisterRecords, Item = &Item) AS S');
    accepted.push('virtual_catalog_parameter_labels_positional_values_and_core_call_generation');
    await client.evaluate('document.querySelector(".source-fields .add-nested").click()');
    await until(() => client.evaluate('!!document.querySelector(".edit-nested")'), 'nested source'); await ready(client);
    await client.evaluate('document.querySelector(".edit-nested").click()');
    await until(() => client.evaluate('!!document.querySelector(".back-parent")'), 'child scope'); await ready(client);
    assert.equal(await client.evaluate('document.querySelectorAll("header select").length'), 0, 'parent cannot be selected interactively inside child scope');
    await editFirstField(client); await form(client, { expression: '2', alias: 'Inner' });
    await textContains(client, '2 AS Inner'); await client.evaluate('document.querySelector(".back-parent").click()');
    await until(() => client.evaluate('!document.querySelector(".back-parent")'), 'parent restored'); await ready(client);
    await client.evaluate(`const field=[...document.querySelectorAll('.field-choice')].find(node=>node.textContent.endsWith('.Inner'));
      if(!field)throw Error('derived field');field.dispatchEvent(new MouseEvent('dblclick',{bubbles:true}));`);
    await until(() => client.evaluate('document.querySelectorAll("[data-section=fields] .row,[data-section=fields] tbody tr").length === 2'), 'derived projection'); await ready(client);
    accepted.push('same_panel_child_navigation_parent_hidden_and_current_derived_projection');
    await client.evaluate('document.getElementById("tab-unions").click();document.querySelector(".add-union").click()');
    await textContains(client, 'UNION ALL');
    await client.evaluate(`const policy=document.querySelector('.union-branches select');policy.value='no';policy.dispatchEvent(new Event('change',{bubbles:true}));`);
    await until(() => client.evaluate(`!document.querySelector('.query-preview pre').textContent.includes('UNION ALL')`), 'distinct union'); await ready(client);
    await client.evaluate(`document.querySelector('[data-branch="1"] button').click()`);
    await until(() => client.evaluate(`document.querySelectorAll('header select')[1]?.value === '1'`), 'selected union branch'); await ready(client);
    await client.evaluate('document.getElementById("tab-order").click();document.querySelector("[data-section=order] .action-add").click()');
    await form(client, { expression: 'Value', descending: 'yes' }); await textContains(client, 'ORDER BY Value DESC');
    await client.evaluate('document.getElementById("tab-totals").click();document.querySelector("[data-section=totals] .action-add").click()');
    await form(client, { expression: 'Value', aggregate: 'sum' }); await textContains(client, 'TOTALS SUM(Value)');
    await client.evaluate('document.querySelector("[data-section=totalGroups] .action-add").click()');
    await client.evaluate(`const unit=document.querySelector('.expression [name=periodUnit]');unit.value='month';unit.dispatchEvent(new Event('change',{bubbles:true}));`);
    await form(client, { expression: 'Value', begin: '&Begin', end: '&End' }); await textContains(client, 'PERIODS(MONTH, &Begin, &End)');
    await client.evaluate(`document.getElementById("tab-unions").click();document.querySelector('[data-branch="1"] .remove-union').click()`);
    await until(() => client.evaluate(`!document.querySelector('.query-preview pre').textContent.includes('UNION')`), 'branch removed'); await ready(client);
    assert.equal(await client.evaluate('!!document.querySelector(".back-parent")'), false, 'removal stays in original root scope');
    await client.evaluate('document.querySelector(".add-union").click()'); await textContains(client, 'UNION ALL');
    await client.evaluate('document.getElementById("tab-totals").click()');
    const text = await client.evaluate('document.querySelector(".query-preview pre").textContent');
    assert.ok(text.lastIndexOf('TOTALS') > text.lastIndexOf('UNION'));
    assert.equal(draft.getText(), before); assert.equal(parentTabs(uri).length, 0); assert.deepEqual(await fs.readFile(fixture.module), disk);
    accepted.push('union_duplicate_policy_scope_tail_order_overall_totals_and_period_fill');
    if (process.env.ESKA_HOST_DOM_ARTIFACTS) {
      await fs.mkdir(process.env.ESKA_HOST_DOM_ARTIFACTS, { recursive: true });
      await client.screenshot(path.join(process.env.ESKA_HOST_DOM_ARTIFACTS, `query-advanced-${vscode.env.language}.png`));
    }
    await client.evaluate('document.querySelector("header button").click()'); client.close(); client = undefined;
    const changed = await until(() => vscode.window.activeTextEditor?.document.uri.toString() === draft.uri.toString()
      && vscode.window.activeTextEditor.document.getText().includes('PERIODS') && vscode.window.activeTextEditor.document, 'accepted same query');
    assert.equal(changed.getText(), text); await vscode.commands.executeCommand('undo'); assert.equal(changed.getText(), before);
    await vscode.commands.executeCommand('redo'); assert.equal(changed.getText(), text);
    await vscode.commands.executeCommand('eska.explorer.applyQuery', changed.uri);
    const updated = await returned(uri); assert.equal(updated.isDirty, true); assert.ok(updated.getText().includes('BalanceAndTurnovers'));
    assert.deepEqual(await fs.readFile(fixture.module), disk); await vscode.commands.executeCommand('undo'); assert.equal(updated.getText(), original);
    accepted.push('advanced_draft_one_undo_redo_unsaved_parent_apply_and_one_owner_undo');
    await fs.writeFile(path.join(fixture.root, 'host-result.json'), JSON.stringify({ passed: true, suite: 'query-advanced', locale: vscode.env.language, accepted }));
  } catch (error) {
    await fs.writeFile(path.join(fixture.root, 'host-result.json'), JSON.stringify({ passed: false, suite: 'query-advanced', error: String(error.stack ?? error), accepted })); throw error;
  } finally { client?.close(); }
};
