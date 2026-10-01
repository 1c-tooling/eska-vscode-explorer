const vscode = require('vscode');
const fs = require('node:fs/promises');
const path = require('node:path');
const assert = require('node:assert/strict');
const { frame, until } = require('./webview-host.cjs');

/** A nullable type link shares the source picker and preserves its unsigned index. */
exports.run = async function () {
  const fixture = JSON.parse(process.env.ESKA_HOST_FIXTURE);
  const file = fixture.descriptor;
  const original = (await fs.readFile(file, 'utf8')).replace('<Name>Артикул</Name>', '<Name>Артикул</Name><LinkByType xmlns:r="http://v8.1c.ru/8.3/xcf/readable"/>');
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
    /** Schema addresses can change after setting or clearing a singular structured property. */
    function index(name) { return tab.state.editing.schema.fields.findIndex(field => field.path[0].key.name === 'LinkByType' && field.path.at(-1).key.name === name); }
    /** Select a localized source through the actual native QuickPick. */
    async function choose(query) {
      const source = index('LinkByType');
      assert.ok(source >= 0);
      await until(() => dom.evaluate(`!!document.getElementById('edit-${source}')`), 'type source rendered');
      await dom.evaluate(`document.getElementById('edit-${source}').click()`);
      await until(() => dom.workbench("Boolean(document.querySelector('.quick-input-widget:not([style*=\"display: none\"]) input'))"), 'type source picker');
      await dom.workbench(`(()=>{const input=document.querySelector('.quick-input-widget input[type=text]');input.focus();input.value=${JSON.stringify(query)};input.dispatchEvent(new Event('input',{bubbles:true}));})()`);
      await until(() => dom.workbench("document.querySelectorAll('.quick-input-list .monaco-list-row').length === 1"), 'one matching source');
      await vscode.commands.executeCommand('workbench.action.acceptSelectedQuickOpenItem');
    }
    assert.equal(index('LinkItem'), -1);
    await choose('Deletion mark');
    await until(async () => !tab.state.editing.busy && (await fs.readFile(file, 'utf8')).includes('>Catalog.Товары.StandardAttribute.DeletionMark<'), 'type source autosaved');
    const selected = await fs.readFile(file, 'utf8');
    const item = index('LinkItem');
    assert.ok(item >= 0);
    await until(() => dom.evaluate(`!!document.getElementById('edit-${item}')`), 'element index rendered');
    assert.match(await dom.evaluate(`document.getElementById('edit-${item}-range').textContent`), /4294967295/);
    assert.equal(await dom.evaluate(`document.querySelector('label[for="edit-${index('LinkByType')}"]').textContent`), '');
    /** Commit an integer with the same DOM events used by keyboard entry. */
    async function enter(value) {
      await dom.evaluate(`(() => { const input = document.getElementById('edit-${item}'); input.value = ${JSON.stringify(value)}; input.dispatchEvent(new Event('input', {bubbles:true})); input.dispatchEvent(new KeyboardEvent('keydown', {key:'Enter',bubbles:true})); })()`);
    }
    await enter('4294967296');
    await until(() => !tab.state.editing.busy && tab.state.notice.includes('outside the allowed domain'), 'overflow rejected');
    assert.equal(await fs.readFile(file, 'utf8'), selected);
    await enter('4294967295');
    const maximum = selected.replace('<r:LinkItem>0</r:LinkItem>', '<r:LinkItem>4294967295</r:LinkItem>');
    await until(async () => !tab.state.editing.busy && await fs.readFile(file, 'utf8') === maximum, 'unsigned maximum autosaved');
    await dom.screenshot('type-links-properties.png');
    await choose('Not set');
    await until(async () => !tab.state.editing.busy && index('LinkItem') === -1, 'type link cleared');
    const cleared = await fs.readFile(file, 'utf8');
    assert.equal(cleared, maximum.replace(/<r:DataPath>[^<]*<\/r:DataPath><r:LinkItem>[^<]*<\/r:LinkItem>/, ''));
    for (const expected of [maximum, selected, original]) {
      await dom.evaluate("document.getElementById('undo').click()");
      await until(async () => !tab.state.editing.busy && await fs.readFile(file, 'utf8') === expected, 'exact type link undo');
    }
    await fs.writeFile(path.join(fixture.root, 'host-result.json'), JSON.stringify({ passed:true, suite:'property-type-links', vscode:vscode.version }));
  } finally { dom.close(); }
};
