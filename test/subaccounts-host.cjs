const vscode = require('vscode');
const fs = require('node:fs/promises');
const path = require('node:path');
const assert = require('node:assert/strict');
const { frame, until } = require('./webview-host.cjs');

/** Select a plan through the real picker, then edit the newly enabled count. */
exports.run = async function () {
  const fixture = JSON.parse(process.env.ESKA_HOST_FIXTURE);
  const rootFile = path.join(fixture.source, 'Configuration.xml');
  await fs.writeFile(rootFile, (await fs.readFile(rootFile, 'utf8')).replace('</ChildObjects>', '<ChartOfAccounts>AccountsProbe</ChartOfAccounts><ChartOfCharacteristicTypes>TypesProbe</ChartOfCharacteristicTypes></ChildObjects>'));
  for (const [folder, tag, name, fields] of [
    ['ChartsOfAccounts', 'ChartOfAccounts', 'AccountsProbe', '<ExtDimensionTypes></ExtDimensionTypes><MaxExtDimensionCount>0</MaxExtDimensionCount>'],
    ['ChartsOfCharacteristicTypes', 'ChartOfCharacteristicTypes', 'TypesProbe', ''],
  ]) {
    await fs.mkdir(path.join(fixture.source, folder), { recursive: true });
    await fs.writeFile(path.join(fixture.source, folder, name + '.xml'), '\ufeff<MetaDataObject xmlns="http://v8.1c.ru/8.3/MDClasses" version="2.20"><' + tag + ' uuid="88888888-8888-8888-8888-888888888888"><Properties><Name>' + name + '</Name>' + fields + '</Properties><ChildObjects/></' + tag + '></MetaDataObject>\r\n');
  }
  const file = path.join(fixture.source, 'ChartsOfAccounts/AccountsProbe.xml');
  const original = await fs.readFile(file, 'utf8');
  await fs.mkdir(path.join(fixture.source, 'Ext'), { recursive: true });
  await fs.writeFile(path.join(fixture.source, 'Ext/ParentConfigurations.bin'), '{6,0,0,0,0,0}');
  await vscode.workspace.getConfiguration('eska.explorer').update('executable', process.env.ESKA_TEST_BINARY, vscode.ConfigurationTarget.Workspace);
  const explorer = await vscode.extensions.all.find(item => item.packageJSON.name === 'eska-explorer').activate();
  await vscode.commands.executeCommand('eska.explorer.connect');
  const [root] = (await explorer.getChildren()).filter(entry => entry.node);
  const charts = (await explorer.getChildren(root)).find(entry => entry.node.id.collection?.metadataKind === 'chart-of-accounts');
  const entry = (await explorer.getChildren(charts)).find(entry => entry.node.label.text === 'AccountsProbe');
  await vscode.commands.executeCommand('eska.explorer.properties', entry);
  const [tab] = explorer.propertiesTabs.tabs.values();
  const dom = await frame(tab);
  try {
    await until(() => dom.evaluate("!document.getElementById('read-only').disabled"), 'tab loaded');
    await dom.evaluate("document.getElementById('read-only').click()");
    await until(() => dom.evaluate('[...document.querySelectorAll(".property-restriction")].some(node => node.textContent.includes("Select an extra dimension type plan"))'), 'missing plan reason');
    const index = tab.state.editing.schema.fields.findIndex(field => field.path[0].key.name === 'ExtDimensionTypes');
    await dom.evaluate(`document.getElementById('edit-${index}').click()`);
    await until(() => dom.workbench("document.querySelector('.quick-input-list')?.textContent.includes('TypesProbe')"), 'plan picker');
    await dom.workbench("(() => {const input=document.querySelector('.quick-input-widget input[type=text]');input.value='TypesProbe';input.dispatchEvent(new Event('input',{bubbles:true}));})()");
    await until(() => dom.workbench("document.querySelectorAll('.quick-input-list .monaco-list-row').length===1"), 'filtered plan');
    await vscode.commands.executeCommand('workbench.action.acceptSelectedQuickOpenItem');
    const selected = original.replace('<ExtDimensionTypes>', '<ExtDimensionTypes>ChartOfCharacteristicTypes.TypesProbe');
    await until(async () => !tab.state.editing.busy && await fs.readFile(file, 'utf8') === selected, 'selected plan saved');
    await until(() => dom.evaluate('document.querySelectorAll(".property-restriction").length === 0'), 'count enabled');
    const count = tab.state.editing.schema.fields.findIndex(field => field.path[0].key.name === 'MaxExtDimensionCount');
    assert.deepEqual(tab.state.editing.schema.fields[count].schema, { kind: 'integer', min: 0, max: 50 });
    await dom.evaluate(`(() => { const input = document.getElementById('edit-${count}'); input.value = '50'; input.dispatchEvent(new Event('input', {bubbles: true})); input.dispatchEvent(new KeyboardEvent('keydown', {key: 'Enter', bubbles: true})); })()`);
    await until(async () => !tab.state.editing.busy && await fs.readFile(file, 'utf8') === selected.replace('<MaxExtDimensionCount>0', '<MaxExtDimensionCount>50'), 'maximum count saved');
    await dom.screenshot('subaccounts-properties.png');
    for (const expected of [selected, original]) {
      await dom.evaluate("document.getElementById('undo').click()");
      await until(async () => !tab.state.editing.busy && await fs.readFile(file, 'utf8') === expected, 'subaccount undo');
    }
    await fs.writeFile(path.join(fixture.root, 'host-result.json'), JSON.stringify({ passed: true, suite: 'property-subaccounts', vscode: vscode.version }));
  } finally { dom.close(); }
};
