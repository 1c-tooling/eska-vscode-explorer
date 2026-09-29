const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const vscode = require('vscode');

/** Exercise object-scoped webview tabs and their XML action in VSCodium. */
exports.run = async function () {
  const fixture = JSON.parse(process.env.ESKA_HOST_FIXTURE);
  const xml = await fs.readFile(fixture.descriptor, 'utf8');
  assert.ok(xml.includes('<Comment>😀 Кириллица</Comment>'));
  await fs.writeFile(fixture.descriptor, xml.replace('<Comment>😀 Кириллица</Comment>',
    '<Comment>😀 Кириллица</Comment>'
      + '<Synonym xmlns:v8="http://v8.1c.ru/8.1/data/core"><v8:item><v8:lang>ru</v8:lang>'
      + '<v8:content>Каталог товаров</v8:content></v8:item></Synonym>'
      + '<Hierarchical>true</Hierarchical><CheckUnique>false</CheckUnique>'
      + '<Flags><Visible>true</Visible><Hidden>false</Hidden></Flags>'));
  await vscode.workspace.getConfiguration('eska.explorer').update('executable', process.env.ESKA_TEST_BINARY, vscode.ConfigurationTarget.Workspace);
  await vscode.workspace.getConfiguration('eska.explorer').update('treeLanguage', 'ru-RU', vscode.ConfigurationTarget.Workspace);
  const extension = vscode.extensions.all.find(value => value.packageJSON.name === 'eska-explorer');
  const explorer = await extension.activate();
  await vscode.commands.executeCommand('eska.explorer.connect');
  const [root] = (await explorer.getChildren()).filter(entry => entry.node);
  const catalogs = (await explorer.getChildren(root)).find(entry => entry.node.id.collection?.metadataKind === 'catalog');
  const objects = await explorer.getChildren(catalogs);
  const goods = objects.find(entry => entry.node.label.text === 'Товары');
  const customers = objects.find(entry => entry.node.label.text === 'Покупатели');
  const modules = (await explorer.getChildren(goods)).find(entry => entry.node.id.collection?.kind === 'modules');
  const [module] = await explorer.getChildren(modules);
  assert.equal(explorer.getTreeItem(catalogs).contextValue, 'eskaMetadataGroup');
  assert.equal(explorer.getTreeItem(goods).contextValue, 'eskaMetadata');
  assert.equal(explorer.getTreeItem(module).command.command, 'eska.explorer.openSource');
  const manifest = extension.packageJSON;
  const action = manifest.contributes.menus['view/item/context'].find(item => item.command === 'eska.explorer.properties');
  const ru = JSON.parse(await fs.readFile(path.join(extension.extensionPath, 'package.nls.ru.json'), 'utf8'));
  assert.equal(ru.properties, 'Свойства');
  assert.ok(action.when.includes('viewItem == eskaMetadata'));
  assert.ok(!action.when.includes('eskaMetadataGroup'));
  await vscode.commands.executeCommand(action.command, goods);
  const [first] = explorer.propertiesTabs.tabs.values();
  assert.equal(explorer.propertiesTabs.tabs.size, 1);
  assert.equal(first.state.status, 'ready');
  assert.equal(first.state.title, 'Каталог товаров');
  assert.ok(first.panel.title.startsWith('Каталог товаров · '));
  assert.equal(first.state.language, 'ru-RU');
  assert.deepEqual(first.state.properties.find(property => property.key.name === 'Name').caption,
    { 'ru-RU': 'Имя', 'en-US': 'Name' });
  assert.equal(first.state.properties.find(property => property.key.name === 'Hierarchical').caption['ru-RU'], 'Иерархический');
  assert.equal(first.state.properties.find(property => property.key.name === 'CheckUnique').caption['en-US'], 'Check for uniqueness');
  assert.equal(first.state.properties.find(property => property.key.name === 'Comment').key.namespace,
    'http://v8.1c.ru/8.3/MDClasses');
  assert.equal(first.state.properties.find(property => property.key.name === 'Hierarchical').value.text, 'true');
  assert.equal(first.state.properties.find(property => property.key.name === 'CheckUnique').value.text, 'false');
  assert.deepEqual(first.state.properties.find(property => property.key.name === 'Flags').value.fields
    .map(field => field.value.text), ['true', 'false']);
  assert.ok(first.panel.visible);
  assert.ok(first.panel.webview.html.includes('Content-Security-Policy'));
  assert.ok(first.panel.webview.html.includes('view.css'));
  assert.ok(first.choices.some(choice => choice.label === 'Comment'));
  await vscode.commands.executeCommand(action.command, goods);
  assert.equal([...explorer.propertiesTabs.tabs.values()][0], first, 'the same object reuses its editor tab');
  await vscode.commands.executeCommand(action.command, customers);
  assert.equal(explorer.propertiesTabs.tabs.size, 2, 'another object gets a separate tab');
  const second = [...explorer.propertiesTabs.tabs.values()].find(tab => tab !== first);
  assert.equal(second.state.title, 'Покупатели', 'objects without a synonym keep their name');
  let webviews = [];
  for (let attempt = 0; attempt < 50; attempt++) {
    webviews = vscode.window.tabGroups.all.flatMap(group => group.tabs)
      .filter(tab => / · (Properties|Свойства)$/.test(tab.label));
    if (webviews.length === 2) break;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.equal(webviews.length, 2, JSON.stringify(vscode.window.tabGroups.all.flatMap(group => group.tabs.map(tab => tab.label))));
  await vscode.workspace.getConfiguration('eska.explorer').update('treeLanguage', 'en-US', vscode.ConfigurationTarget.Workspace);
  for (let attempt = 0; attempt < 50 && first.state.language !== 'en-US'; attempt++) {
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.equal(first.state.language, 'en-US', 'an open tab follows the tree language');
  assert.equal(first.state.properties.find(property => property.key.name === 'CheckUnique').caption[first.state.language], 'Check for uniqueness');
  assert.equal(first.state.title, 'Каталог товаров', 'a missing English synonym falls back to an existing one');
  await vscode.workspace.getConfiguration('eska.explorer').update('treeLanguage', 'ru-RU', vscode.ConfigurationTarget.Workspace);
  for (let attempt = 0; attempt < 50 && first.state.language !== 'ru-RU'; attempt++) {
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.equal(first.state.language, 'ru-RU');
  const comment = first.choices.find(choice => choice.label === 'Comment');
  await first.receive({ type: 'openXml', revision: first.state.revision, index: comment.index });
  const editor = vscode.window.activeTextEditor;
  assert.equal(editor.document.uri.fsPath, fixture.descriptor);
  assert.equal(editor.document.getText(editor.selection), '<Comment>😀 Кириллица</Comment>');
  assert.equal(explorer.propertiesTabs.tabs.size, 2, 'opening XML leaves property tabs in place');
  await vscode.commands.executeCommand('eska.explorer.disconnect');
  await fs.writeFile(path.join(fixture.root, 'host-result.json'), JSON.stringify({ passed: true, suite: 'properties', vscode: vscode.version }));
};
