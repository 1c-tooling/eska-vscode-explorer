const vscode = require('vscode');
const fs = require('node:fs/promises');
const path = require('node:path');
const assert = require('node:assert/strict');
const { frame, until } = require('./webview-host.cjs');

/** Existing parameter names, scalar types and array entries survive real native pickers and undo. */
exports.run = async function () {
  const fixture = JSON.parse(process.env.ESKA_HOST_FIXTURE);
  const file = fixture.descriptor;
  const parameters = '<ChoiceParameters xmlns:a="http://v8.1c.ru/8.2/managed-application/core" xmlns:v="http://v8.1c.ru/8.1/data/core" xmlns:s="http://www.w3.org/2001/XMLSchema-instance" xmlns:x="http://www.w3.org/2001/XMLSchema"><a:item name="Filter.Owner"><a:value s:type="x:boolean">true</a:value></a:item><a:item name="Array"><a:value s:type="v:FixedArray"><v:Value s:type="x:string">first</v:Value><v:Value s:type="x:string">second</v:Value></a:value></a:item></ChoiceParameters>';
  const original = (await fs.readFile(file, 'utf8')).replace('<Name>Артикул</Name>', '<Name>Артикул</Name>' + parameters);
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
    const scalar = fields.findIndex(field => field.schema.domain === 'choiceParameter' && field.value === 'true');
    const array = fields.findIndex(field => field.schema.domain === 'choiceParameter' && field.value === 'second');
    assert.ok(name >= 0 && scalar >= 0 && array >= 0);
    await until(() => dom.evaluate(`!!document.getElementById('edit-${name}')`), 'parameter input rendered');
    assert.match(await dom.evaluate(`document.querySelector('label[for="edit-${name}"]').textContent`), /Filter.Owner.*Parameter name/);
    assert.match(await dom.evaluate(`document.querySelector('label[for="edit-${array}"]').textContent`), /Array.*2/);
    await dom.evaluate(`(() => {const input=document.getElementById('edit-${name}');input.value='Filter.Recipient';input.dispatchEvent(new Event('input',{bubbles:true}));input.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}));})()`);
    const renamed = original.replace('name="Filter.Owner"', 'name="Filter.Recipient"');
    await until(async () => !tab.state.editing.busy && await fs.readFile(file, 'utf8') === renamed, 'name attribute autosaved');
    /** Search and accept one visible native picker option; no host mutation shortcut is used. */
    async function pick(query) {
      await until(() => dom.workbench("Boolean(document.querySelector('.quick-input-widget:not([style*=\"display: none\"]) input'))"), 'native picker visible');
      await dom.workbench(`(()=>{const input=document.querySelector('.quick-input-widget input[type=text]');input.focus();input.value=${JSON.stringify(query)};input.dispatchEvent(new Event('input',{bubbles:true}));})()`);
      await until(() => dom.workbench("document.querySelectorAll('.quick-input-list .monaco-list-row').length===1"), 'single matching option');
      await vscode.commands.executeCommand('workbench.action.acceptSelectedQuickOpenItem');
    }
    await dom.evaluate(`document.getElementById('edit-${scalar}').click()`);
    await pick('Товары');
    await pick('Empty reference');
    await until(async () => !tab.state.editing.busy && (await fs.readFile(file,'utf8')).includes('>Catalog.Товары.EmptyRef</a:value>'), 'reference value autosaved');
    const reference = await fs.readFile(file, 'utf8');
    await dom.evaluate(`document.getElementById('edit-${array}').click()`);
    await pick('String');
    await until(() => dom.workbench("document.querySelector('.quick-input-widget input[type=text]')?.value === 'second'"), 'existing array value shown');
    await dom.workbench("(()=>{const input=document.querySelector('.quick-input-widget input[type=text]');input.value='updated';input.dispatchEvent(new Event('input',{bubbles:true}));})()");
    await vscode.commands.executeCommand('workbench.action.acceptSelectedQuickOpenItem');
    await until(async () => !tab.state.editing.busy && await fs.readFile(file,'utf8') === reference.replace('>second<','>updated<'), 'one array entry autosaved');
    await dom.screenshot('choice-parameters-properties.png');
    for (const expected of [reference, renamed, original]) {
      await dom.evaluate("document.getElementById('undo').click()");
      await until(async () => !tab.state.editing.busy && await fs.readFile(file,'utf8') === expected, 'parameter undo');
    }
    await fs.writeFile(path.join(fixture.root,'host-result.json'), JSON.stringify({passed:true,suite:'property-choice-parameters',vscode:vscode.version}));
  } finally { dom.close(); }
};
