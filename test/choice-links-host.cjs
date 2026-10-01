const vscode = require('vscode');
const fs = require('node:fs/promises');
const path = require('node:path');
const assert = require('node:assert/strict');
const { frame, until } = require('./webview-host.cjs');

/** Existing link rows preserve their identities while names and modes autosave independently. */
exports.run = async function () {
  const fixture = JSON.parse(process.env.ESKA_HOST_FIXTURE);
  const file = fixture.descriptor;
  const links = '<ChoiceParameterLinks xmlns:r="http://v8.1c.ru/8.3/xcf/readable"><r:Link><r:Name>Filter.Owner</r:Name><r:DataPath>Catalog.Товары.StandardAttribute.Code</r:DataPath><r:ValueChange>Clear</r:ValueChange></r:Link><r:Link><r:Name>Other</r:Name><r:DataPath>Catalog.Товары.StandardAttribute.Description</r:DataPath><r:ValueChange>DontChange</r:ValueChange></r:Link></ChoiceParameterLinks>';
  const original = (await fs.readFile(file, 'utf8')).replace('<Name>Артикул</Name>', '<Name>Артикул</Name>' + links);
  await fs.writeFile(file, original);
  await fs.mkdir(path.join(fixture.source, 'Ext'), { recursive: true });
  await fs.writeFile(path.join(fixture.source, 'Ext/ParentConfigurations.bin'), '{6,0,0,0,0,0}');
  await vscode.workspace.getConfiguration('eska.explorer').update('executable', process.env.ESKA_TEST_BINARY, vscode.ConfigurationTarget.Workspace);
  const explorer = await vscode.extensions.all.find(item => item.packageJSON.name === 'eska-explorer').activate();
  await vscode.commands.executeCommand('eska.explorer.connect');
  const [root] = (await explorer.getChildren()).filter(entry => entry.node);
  const catalogs = (await explorer.getChildren(root)).find(entry => entry.node.id.collection?.metadataKind === 'catalog');
  const catalog = (await explorer.getChildren(catalogs)).find(entry => entry.node.label.text === 'Товары');
  const attributes = (await explorer.getChildren(catalog)).find(entry => entry.node.id.collection?.metadataKind === 'attribute');
  const entry = (await explorer.getChildren(attributes)).find(entry => entry.node.label.text === 'Артикул');
  await vscode.commands.executeCommand('eska.explorer.properties', entry);
  const [tab] = explorer.propertiesTabs.tabs.values();
  const dom = await frame(tab);
  try {
    await until(() => dom.evaluate("!document.getElementById('read-only').disabled"), 'tab loaded');
    assert.equal(tab.state.editing.unlocked, false);
    await dom.evaluate("document.getElementById('read-only').click()");
    await until(() => tab.state.editing.unlocked, 'tab unlocked');
    const fields = tab.state.editing.schema.fields;
    const name = fields.findIndex(field => field.schema.domain === 'choiceParameterName');
    const mode = fields.findIndex(field => field.schema.domain === 'LinkedValueChangeMode');
    assert.ok(name >= 0 && mode >= 0);
    await until(() => dom.evaluate(`!!document.getElementById('edit-${name}')`), 'link input rendered');
    assert.match(await dom.evaluate(`document.querySelector('label[for="edit-${name}"]').textContent`), /Filter.Owner/);
    assert.match(await dom.evaluate(`document.getElementById('edit-${name}-constraint').textContent`), /two parts/);
    /** Drive native webview events rather than calling the backend mutation directly. */
    async function enter(value) {
      await dom.evaluate(`(() => { const input = document.getElementById('edit-${name}'); input.value = ${JSON.stringify(value)}; input.dispatchEvent(new Event('input', {bubbles: true})); input.dispatchEvent(new KeyboardEvent('keydown', {key: 'Enter', bubbles: true})); })()`);
    }
    await enter('Other.Child');
    await until(() => !tab.state.editing.busy && tab.state.notice.includes('outside the allowed domain'), 'conflicting name rejected');
    assert.equal(await fs.readFile(file, 'utf8'), original);
    assert.equal(tab.state.editing.drafts[JSON.stringify(fields[name].path)].value, 'Other.Child');
    await dom.evaluate(`document.getElementById('edit-${name}').dispatchEvent(new KeyboardEvent('keydown', {key: 'Escape', bubbles: true}))`);
    await until(() => Object.keys(tab.state.editing.drafts).length === 0, 'draft cancelled');
    await enter('Filter.Recipient');
    const renamed = original.replace('>Filter.Owner<', '>Filter.Recipient<');
    await until(async () => !tab.state.editing.busy && await fs.readFile(file, 'utf8') === renamed, 'only nested name changed');
    await until(() => dom.evaluate(`document.getElementById('edit-${name}').value === 'Filter.Recipient'`), 'saved name displayed');
    await dom.evaluate(`(() => {const select = document.getElementById('edit-${mode}'); select.value = 'DontChange'; select.dispatchEvent(new Event('change', {bubbles:true})); })()`);
    await until(async () => !tab.state.editing.busy && await fs.readFile(file, 'utf8') === renamed.replace('>Clear<', '>DontChange<'), 'mode autosaved');
    await dom.screenshot('choice-links-properties.png');
    for (const expected of [renamed, original]) {
      await dom.evaluate("document.getElementById('undo').click()");
      await until(async () => !tab.state.editing.busy && await fs.readFile(file, 'utf8') === expected, 'choice link undo');
    }
    await fs.writeFile(path.join(fixture.root, 'host-result.json'), JSON.stringify({ passed: true, suite: 'property-choice-links', vscode: vscode.version }));
  } finally { dom.close(); }
};
