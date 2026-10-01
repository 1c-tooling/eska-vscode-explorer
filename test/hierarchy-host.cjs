const vscode = require('vscode');
const fs = require('node:fs/promises');
const path = require('node:path');
const assert = require('node:assert/strict');
const { frame } = require('./webview-host.cjs');

/** Wait for a specific save or rendered state rather than racing a webview refresh. */
async function until(condition, label) {
  for (let i = 0; i < 100; i++) {
    if (await condition()) return;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error(label);
}

/** Exercise prerequisite hints and a bounded numeric edit through the actual native webview. */
exports.run = async function () {
  const fixture = JSON.parse(process.env.ESKA_HOST_FIXTURE);
  const rootFile = path.join(fixture.source, 'Configuration.xml');
  await fs.writeFile(rootFile, (await fs.readFile(rootFile, 'utf8')).replace('</ChildObjects>', '<Catalog>HierarchyProbe</Catalog></ChildObjects>'));
  const file = path.join(fixture.source, 'Catalogs/HierarchyProbe.xml');
  const original = '\ufeff<MetaDataObject xmlns="http://v8.1c.ru/8.3/MDClasses" version="2.20"><Catalog uuid="88888888-8888-8888-8888-888888888888"><Properties><Name>HierarchyProbe</Name><Hierarchical>false</Hierarchical><HierarchyType>HierarchyFoldersAndItems</HierarchyType><LimitLevelCount>false</LimitLevelCount><LevelCount>2</LevelCount></Properties><ChildObjects/></Catalog></MetaDataObject>\r\n';
  await fs.writeFile(file, original);
  await fs.mkdir(path.join(fixture.source, 'Ext'), { recursive: true });
  await fs.writeFile(path.join(fixture.source, 'Ext/ParentConfigurations.bin'), '{6,0,0,0,0,0}');
  await vscode.workspace.getConfiguration('eska.explorer').update('executable', process.env.ESKA_TEST_BINARY, vscode.ConfigurationTarget.Workspace);
  const explorer = await vscode.extensions.all.find(item => item.packageJSON.name === 'eska-explorer').activate();
  await vscode.commands.executeCommand('eska.explorer.connect');
  const [root] = (await explorer.getChildren()).filter(entry => entry.node);
  const catalogs = (await explorer.getChildren(root)).find(entry => entry.node.id.collection?.metadataKind === 'catalog');
  const entry = (await explorer.getChildren(catalogs)).find(entry => entry.node.label.text === 'HierarchyProbe');
  await vscode.commands.executeCommand('eska.explorer.properties', entry);
  const [tab] = explorer.propertiesTabs.tabs.values();
  const dom = await frame(tab);
  try {
    await until(() => dom.evaluate("!document.getElementById('read-only').disabled"), 'tab loaded');
    assert.equal(await dom.evaluate('document.querySelectorAll(".property-restriction").length'), 0);
    await dom.evaluate("document.getElementById('read-only').click()");
    await until(() => dom.evaluate('[...document.querySelectorAll(".property-restriction")].filter(node => node.textContent.includes("Enable hierarchy")).length === 3'), 'hierarchy reasons');
    for (const property of ['Hierarchical', 'LimitLevelCount']) {
      const index = tab.state.editing.schema.fields.findIndex(field => field.path[0].key.name === property);
      assert.ok(index >= 0, property);
      await dom.evaluate(`document.getElementById('edit-${index}').click()`);
      await until(async () => !tab.state.editing.busy && (await fs.readFile(file, 'utf8')).includes(`<${property}>true</${property}>`), `${property} saved`);
      if (property === 'Hierarchical') {
        await until(() => dom.evaluate('[...document.querySelectorAll(".property-restriction")].some(node => node.textContent.includes("Enable the level limit"))'), 'limit reason');
      }
    }
    await until(() => dom.evaluate('document.querySelectorAll(".property-restriction").length === 0'), 'level input enabled');
    const index = tab.state.editing.schema.fields.findIndex(field => field.path[0].key.name === 'LevelCount');
    assert.deepEqual(tab.state.editing.schema.fields[index].schema, { kind: 'integer', min: 2, max: 10 });
    const before = original.replace('<Hierarchical>false', '<Hierarchical>true').replace('<LimitLevelCount>false', '<LimitLevelCount>true');
    assert.equal(await fs.readFile(file, 'utf8'), before);
    await dom.evaluate(`(() => { const input = document.getElementById('edit-${index}'); input.value = '10'; input.dispatchEvent(new Event('input', {bubbles: true})); input.dispatchEvent(new KeyboardEvent('keydown', {key: 'Enter', bubbles: true})); })()`);
    await until(async () => !tab.state.editing.busy && (await fs.readFile(file, 'utf8')).includes('<LevelCount>10</LevelCount>'), 'level count saved');
    assert.equal(await fs.readFile(file, 'utf8'), before.replace('<LevelCount>2', '<LevelCount>10'));
    await dom.screenshot('hierarchy-properties.png');
    await dom.evaluate("document.getElementById('undo').click()");
    await until(async () => !tab.state.editing.busy && await fs.readFile(file, 'utf8') === before, 'level count undo');
    await fs.writeFile(path.join(fixture.root, 'host-result.json'), JSON.stringify({ passed: true, suite: 'property-hierarchy', vscode: vscode.version }));
  } finally { dom.close(); }
};
