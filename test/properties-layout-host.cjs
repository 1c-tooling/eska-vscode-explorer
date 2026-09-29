const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const vscode = require('vscode');

/** Exercise value translations and nested layouts against the real backend and webview host. */
exports.run = async function () {
  const fixture = JSON.parse(process.env.ESKA_HOST_FIXTURE);
  const descriptor = path.join(fixture.source, 'Configuration.xml');
  const functionalities = ['Biometrics', 'Location', 'BackgroundLocation', 'BluetoothPrinters',
    'WiFiPrinters', 'Contacts', 'Calendars', 'PushNotifications'];
  const extra = '<CompatibilityMode>Version8_3_27</CompatibilityMode>'
    + '<InterfaceCompatibilityMode>TaxiEnableVersion8_2</InterfaceCompatibilityMode>'
    + '<UsedMobileApplicationFunctionalities xmlns:app="http://v8.1c.ru/8.2/managed-application/core">'
    + functionalities.map((name, index) => `<app:functionality><app:functionality>${name}</app:functionality><app:use>${index % 2 === 0}</app:use></app:functionality>`).join('')
    + '</UsedMobileApplicationFunctionalities>';
  await fs.writeFile(descriptor, (await fs.readFile(descriptor, 'utf8')).replace('</Properties>', extra + '</Properties>'));
  const standard = '<StandardAttributes xmlns:xr="http://v8.1c.ru/8.3/xcf/readable" xmlns:v8="http://v8.1c.ru/8.1/data/core" xmlns:xs="http://www.w3.org/2001/XMLSchema">'
    + '<xr:StandardAttribute name="Code"><xr:FillChecking>ShowError</xr:FillChecking><xr:TypeReductionMode>TransformValues</xr:TypeReductionMode></xr:StandardAttribute>'
    + '<xr:StandardAttribute name="Description"><xr:FullTextSearch>Use</xr:FullTextSearch></xr:StandardAttribute></StandardAttributes>';
  const attributeType = '<Type xmlns:v8="http://v8.1c.ru/8.1/data/core" xmlns:xs="http://www.w3.org/2001/XMLSchema"><v8:Type>xs:string</v8:Type><v8:StringQualifiers><v8:Length>9</v8:Length><v8:AllowedLength>Variable</v8:AllowedLength></v8:StringQualifiers></Type>';
  await fs.writeFile(fixture.descriptor, (await fs.readFile(fixture.descriptor, 'utf8'))
    .replace('</Properties>', standard + '</Properties>').replace('<Name>Артикул</Name>', '<Name>Артикул</Name>' + attributeType));
  await vscode.workspace.getConfiguration('eska.explorer').update('executable', process.env.ESKA_TEST_BINARY, vscode.ConfigurationTarget.Workspace);
  await vscode.workspace.getConfiguration('eska.explorer').update('treeLanguage', 'ru-RU', vscode.ConfigurationTarget.Workspace);
  const extension = vscode.extensions.all.find(value => value.packageJSON.name === 'eska-explorer');
  const explorer = await extension.activate();
  await vscode.commands.executeCommand('eska.explorer.connect');
  const [root] = (await explorer.getChildren()).filter(entry => entry.node);
  await vscode.commands.executeCommand('eska.explorer.properties', root);
  const [configuration] = explorer.propertiesTabs.tabs.values();
  const compatibility = configuration.state.properties.find(field => field.key.name === 'CompatibilityMode');
  assert.equal(compatibility.value.text, 'Version8_3_27');
  assert.deepEqual(compatibility.value.caption, { 'ru-RU': 'Версия 8.3.27', 'en-US': 'Version 8.3.27' });
  const mobile = configuration.state.properties.find(field => field.key.name === 'UsedMobileApplicationFunctionalities');
  assert.equal(mobile.value.fields.length, 8);
  assert.equal(mobile.value.fields[0].value.fields[0].value.caption['ru-RU'], 'Биометрия');
  assert.equal(mobile.value.fields[0].value.fields[1].value.text, 'true');
  const catalogs = (await explorer.getChildren(root)).find(entry => entry.node.id.collection?.metadataKind === 'catalog');
  const goods = (await explorer.getChildren(catalogs)).find(entry => entry.node.label.text === 'Товары');
  await vscode.commands.executeCommand('eska.explorer.properties', goods);
  const catalog = [...explorer.propertiesTabs.tabs.values()].find(tab => tab !== configuration);
  const attributes = catalog.state.properties.find(field => field.key.name === 'StandardAttributes');
  assert.equal(attributes.value.fields[0].qualifiers[0].caption['ru-RU'], 'Код');
  const group = (await explorer.getChildren(goods)).find(entry => entry.node.id.collection?.metadataKind === 'attribute');
  const [attribute] = await explorer.getChildren(group);
  await vscode.commands.executeCommand('eska.explorer.properties', attribute);
  const attributeTab = [...explorer.propertiesTabs.tabs.values()].find(tab => tab !== configuration && tab !== catalog);
  const type = attributeTab.state.properties.find(field => field.key.name === 'Type').value.fields[0];
  assert.equal(type.value.text, 'xs:string');
  assert.deepEqual(type.value.caption, { 'ru-RU': 'Строка', 'en-US': 'String' });
  // Visual acceptance can pause here in a disposable copy of this suite.
  const choice = configuration.choices.find(field => field.label === 'CompatibilityMode');
  await configuration.receive({ type: 'openXml', index: choice.index });
  assert.equal(vscode.window.activeTextEditor.document.getText(vscode.window.activeTextEditor.selection),
    '<CompatibilityMode>Version8_3_27</CompatibilityMode>');
  await vscode.commands.executeCommand('eska.explorer.disconnect');
  await fs.writeFile(path.join(fixture.root, 'host-result.json'), JSON.stringify({ passed: true, suite: 'properties-layout', vscode: vscode.version }));
};
