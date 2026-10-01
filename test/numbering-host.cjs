const vscode = require('vscode');
const fs = require('node:fs/promises');
const path = require('node:path');
const assert = require('node:assert/strict');
const { frame } = require('./webview-host.cjs');

/** Wait for a concrete editor state or write acknowledgement. */
async function until(condition, label) {
  for (let i = 0; i < 100; i++) { if (await condition()) return; await new Promise(resolve => setTimeout(resolve, 50)); }
  throw new Error(label);
}

/** Inherited values retain their readable presentation and explain why no editor is available. */
exports.run = async function () {
  const fixture = JSON.parse(process.env.ESKA_HOST_FIXTURE);
  const rootFile = path.join(fixture.source, 'Configuration.xml');
  await fs.writeFile(rootFile, (await fs.readFile(rootFile, 'utf8')).replace('</ChildObjects>', '<Document>Probe</Document><DocumentNumerator>Shared</DocumentNumerator></ChildObjects>'));
  const namespace = 'http://v8.1c.ru/8.3/MDClasses';
  const numbering = '<NumberType>String</NumberType><NumberLength>9</NumberLength><NumberAllowedLength>Variable</NumberAllowedLength><NumberPeriodicity>Year</NumberPeriodicity><CheckUnique>true</CheckUnique>';
  const file = path.join(fixture.source, 'Documents/Probe.xml');
  const original = `\ufeff<MetaDataObject xmlns="${namespace}" version="2.20"><Document uuid="66666666-6666-6666-6666-666666666666"><Properties><Name>Probe</Name>${numbering}<Autonumbering>true</Autonumbering><Numerator>DocumentNumerator.Shared</Numerator></Properties><ChildObjects/></Document></MetaDataObject>\r\n`;
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, original);
  await fs.mkdir(path.join(fixture.source, 'DocumentNumerators'), { recursive: true });
  await fs.writeFile(path.join(fixture.source, 'DocumentNumerators/Shared.xml'), `<MetaDataObject xmlns="${namespace}" version="2.20"><DocumentNumerator uuid="77777777-7777-7777-7777-777777777777"><Properties><Name>Shared</Name>${numbering}</Properties></DocumentNumerator></MetaDataObject>`);
  await fs.mkdir(path.join(fixture.source, 'Ext'), { recursive: true });
  await fs.writeFile(path.join(fixture.source, 'Ext/ParentConfigurations.bin'), '{6,0,0,0,0,0}');
  await vscode.workspace.getConfiguration('eska.explorer').update('executable', process.env.ESKA_TEST_BINARY, vscode.ConfigurationTarget.Workspace);
  const explorer = await vscode.extensions.all.find(item => item.packageJSON.name === 'eska-explorer').activate();
  await vscode.commands.executeCommand('eska.explorer.connect');
  const [root] = (await explorer.getChildren()).filter(entry => entry.node);
  const group = (await explorer.getChildren(root)).find(entry => entry.node.id.collection?.metadataKind === 'document');
  const entry = (await explorer.getChildren(group)).find(entry => entry.node.label.text === 'Probe');
  await vscode.commands.executeCommand('eska.explorer.properties', entry);
  const [tab] = explorer.propertiesTabs.tabs.values();
  const dom = await frame(tab);
  try {
    assert.equal(await dom.evaluate('document.querySelectorAll(".property-restriction").length'), 0);
    await dom.evaluate("document.getElementById('read-only').click()");
    await until(() => tab.state.editing.unlocked, 'unlock');
    await until(() => dom.evaluate('[...document.querySelectorAll(".property-restriction")].filter(node => node.textContent.includes("Set by")).length === 5'), 'inherited reasons');
    assert.equal(await dom.evaluate('document.querySelector(".property-restriction").textContent'), "Set by the document's number generator.");
    assert.equal(tab.state.editing.schema.fields.some(field => field.path[0].key.name === 'NumberLength'), false);
    const index = tab.state.editing.schema.fields.findIndex(field => field.path[0].key.name === 'Autonumbering');
    await dom.evaluate(`document.getElementById('edit-${index}').click()`);
    await until(async () => !tab.state.editing.busy && (await fs.readFile(file,'utf8')).includes('<Autonumbering>false</Autonumbering>'), 'independent flag save');
    assert.equal(await fs.readFile(file,'utf8'), original.replace('<Autonumbering>true</Autonumbering>', '<Autonumbering>false</Autonumbering>'));
    await dom.screenshot('numbering-properties.png');
    dom.close();
    const numerators = (await explorer.getChildren(group)).find(entry => entry.node.id.collection?.metadataKind === 'document-numerator');
    assert.ok(numerators, 'document number generators');
    const [numerator] = await explorer.getChildren(numerators);
    await vscode.commands.executeCommand('eska.explorer.properties', numerator);
    const numeratorTab = [...explorer.propertiesTabs.tabs.values()].find(tab => tab.entry === numerator);
    const numeratorDom = await frame(numeratorTab);
    try {
      await until(() => numeratorDom.evaluate("!document.getElementById('read-only').disabled"), 'numerator loaded');
      await numeratorDom.evaluate("document.getElementById('read-only').click()");
      try { await until(() => numeratorTab.state.editing.unlocked, 'numerator unlock'); }
      catch (error) { throw new Error(`${error}: ${JSON.stringify(numeratorTab.state.editing)}; status=${numeratorTab.state.status}; notice=${numeratorTab.state.notice}`); }
      await until(() => numeratorDom.evaluate('[...document.querySelectorAll(".property-restriction")].some(node => node.textContent.includes("documents: 1"))'), 'linked hint');
      const length = numeratorTab.state.editing.schema.fields.findIndex(field => field.path[0].key.name === 'NumberLength');
      await numeratorDom.evaluate(`(() => { const control = document.getElementById('edit-${length}'); control.value = '15'; control.dispatchEvent(new Event('input', {bubbles:true})); control.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true})); })()`);
      await until(async () => !numeratorTab.state.editing.busy && (await fs.readFile(file,'utf8')).includes('<NumberLength>15</NumberLength>'), 'linked length save');
      const expected = original.replace('<Autonumbering>true</Autonumbering>', '<Autonumbering>false</Autonumbering>');
      assert.equal(await fs.readFile(file,'utf8'), expected.replace('<NumberLength>9</NumberLength>', '<NumberLength>15</NumberLength>'));
      assert.equal(numeratorTab.state.editing.schema.undoLinked, true);
      await numeratorDom.evaluate("document.getElementById('undo').click()");
      await until(async () => !numeratorTab.state.editing.busy && await fs.readFile(file,'utf8') === expected, 'linked length undo');
      await numeratorDom.screenshot('numerator-properties.png');
    } finally { numeratorDom.close(); }
    await fs.writeFile(path.join(fixture.root,'host-result.json'),JSON.stringify({passed:true,suite:'property-numbering',vscode:vscode.version}));
  } finally { dom.close(); }
};
