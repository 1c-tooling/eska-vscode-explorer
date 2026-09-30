const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const vscode = require('vscode');

/** Verify semantic properties and project-scoped navigation in an installed extension. */
exports.run = async function () {
  const fixture = JSON.parse(process.env.ESKA_HOST_FIXTURE);
  const { descriptor } = await import('./fixture.mjs');
  const rootFile = path.join(fixture.source, 'Configuration.xml');
  await fs.writeFile(rootFile, descriptor('Configuration', 'Тест', '<Catalog>Товары</Catalog><CommonForm>Main</CommonForm>',
    '<DefaultReportForm>CommonForm.Main</DefaultReportForm><DefaultReportVariantForm>CommonForm.Missing</DefaultReportVariantForm>'));
  await fs.mkdir(path.join(fixture.source, 'CommonForms'), { recursive: true });
  await fs.writeFile(path.join(fixture.source, 'CommonForms', 'Main.xml'), descriptor('CommonForm', 'Main', '',
    '<Synonym xmlns:v="http://v8.1c.ru/8.1/data/core"><v:item><v:lang>ru</v:lang><v:content>Форма отчета</v:content></v:item></Synonym>'));
  const type = '<Type xmlns:v="http://v8.1c.ru/8.1/data/core" xmlns:s="http://www.w3.org/2001/XMLSchema" xmlns:c="http://v8.1c.ru/8.1/data/enterprise/current-config"><v:Type>c:CatalogRef.Товары</v:Type><v:Type>s:string</v:Type><v:StringQualifiers><v:Length>100</v:Length><v:AllowedLength>Variable</v:AllowedLength></v:StringQualifiers></Type>';
  const properties = type + '<FillValue xmlns:x="http://www.w3.org/2001/XMLSchema-instance" x:nil="true"/>';
  await fs.writeFile(path.join(fixture.source, 'Catalogs', 'Товары.xml'), descriptor('Catalog', 'Товары',
    `<Attribute uuid="22222222-2222-2222-2222-222222222222"><Properties><Name>Владелец</Name>${properties}</Properties></Attribute>`,
    '<Synonym xmlns:v="http://v8.1c.ru/8.1/data/core"><v:item><v:lang>ru</v:lang><v:content>Номенклатура</v:content></v:item></Synonym>'));
  await vscode.workspace.getConfiguration('eska.explorer').update('executable', process.env.ESKA_TEST_BINARY, vscode.ConfigurationTarget.Workspace);
  await vscode.workspace.getConfiguration('eska.explorer').update('treeLanguage', 'ru-RU', vscode.ConfigurationTarget.Workspace);
  const extension = vscode.extensions.all.find(value => value.packageJSON.name === 'eska-explorer');
  const explorer = await extension.activate();
  await vscode.commands.executeCommand('eska.explorer.connect');
  const [root] = (await explorer.getChildren()).filter(entry => entry.node);
  await vscode.commands.executeCommand('eska.explorer.properties', root);
  const [tab] = explorer.propertiesTabs.tabs.values();
  const ref = tab.state.properties.find(field => field.key.name === 'DefaultReportForm').presentation;
  assert.equal(ref.caption['ru-RU'], 'Форма отчета');
  assert.equal(ref.status, 'resolved');
  const visual = process.env.ESKA_PRESENTATION_VISUAL_PROBE ? require(process.env.ESKA_PRESENTATION_VISUAL_PROBE) : undefined;
  if (visual) await visual.check(vscode, tab, 'references');
  await tab.receive({ type: 'openReference', revision: tab.state.revision, target: ref.target });
  const targetTab = [...explorer.propertiesTabs.tabs.values()].find(value => value !== tab);
  assert.equal(targetTab.state.title, 'Форма отчета');
  assert.equal(targetTab.state.status, 'ready');
  const catalogs = (await explorer.getChildren(root)).find(entry => entry.node?.id.collection?.metadataKind === 'catalog');
  const [catalog] = await explorer.getChildren(catalogs);
  const attributes = (await explorer.getChildren(catalog)).find(entry => entry.node?.id.collection?.metadataKind === 'attribute');
  const [attribute] = await explorer.getChildren(attributes);
  await vscode.commands.executeCommand('eska.explorer.properties', attribute);
  const typeTab = [...explorer.propertiesTabs.tabs.values()].find(value => value.entry === attribute);
  assert.equal(typeTab.state.properties.find(field => field.key.name === 'Type').presentation.kind, 'types');
  assert.equal(typeTab.state.properties.find(field => field.key.name === 'FillValue').presentation.caption['ru-RU'], 'Не задано');
  if (visual) await visual.check(vscode, typeTab, 'types');
  await vscode.commands.executeCommand('eska.explorer.disconnect');
  assert.equal(typeTab.state.status, 'stale');
  await fs.writeFile(path.join(fixture.root, 'host-result.json'), JSON.stringify({ passed: true, suite: 'presentation', vscode: vscode.version }));
};
