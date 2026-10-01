const vscode = require('vscode');
const fs = require('node:fs/promises');
const path = require('node:path');
const assert = require('node:assert/strict');
const { frame } = require('./webview-host.cjs');

/** Wait for the actual rendered response or file write before the next interaction. */
async function until(condition, label) {
  for (let i = 0; i < 100; i++) {
    if (await condition()) return;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error(label);
}

/** A full-width integer must survive DOM input, JSON transport, XML writing and undo exactly. */
exports.run = async function () {
  const fixture = JSON.parse(process.env.ESKA_HOST_FIXTURE);
  const rootFile = path.join(fixture.source, 'Configuration.xml');
  await fs.writeFile(rootFile, (await fs.readFile(rootFile, 'utf8')).replace('</ChildObjects>', '<HTTPService>AgeProbe</HTTPService></ChildObjects>'));
  await fs.mkdir(path.join(fixture.source, 'HTTPServices'), { recursive: true });
  const file = path.join(fixture.source, 'HTTPServices/AgeProbe.xml');
  const original = '\ufeff<MetaDataObject xmlns="http://v8.1c.ru/8.3/MDClasses" version="2.20"><HTTPService uuid="88888888-8888-8888-8888-888888888888"><Properties><Name>AgeProbe</Name><ReuseSessions>AutoUse</ReuseSessions><SessionMaxAge>20</SessionMaxAge></Properties><ChildObjects/></HTTPService></MetaDataObject>\r\n';
  await fs.writeFile(file, original);
  await fs.mkdir(path.join(fixture.source, 'Ext'), { recursive: true });
  await fs.writeFile(path.join(fixture.source, 'Ext/ParentConfigurations.bin'), '{6,0,0,0,0,0}');
  await vscode.workspace.getConfiguration('eska.explorer').update('executable', process.env.ESKA_TEST_BINARY, vscode.ConfigurationTarget.Workspace);
  const explorer = await vscode.extensions.all.find(item => item.packageJSON.name === 'eska-explorer').activate();
  await vscode.commands.executeCommand('eska.explorer.connect');
  const [root] = (await explorer.getChildren()).filter(entry => entry.node);
  const common = (await explorer.getChildren(root)).find(entry => entry.node.id.collection?.kind === 'common');
  const services = (await explorer.getChildren(common)).find(entry => entry.node.id.collection?.metadataKind === 'http-service');
  const entry = (await explorer.getChildren(services)).find(entry => entry.node.label.text === 'AgeProbe');
  await vscode.commands.executeCommand('eska.explorer.properties', entry);
  const [tab] = explorer.propertiesTabs.tabs.values();
  const dom = await frame(tab);
  try {
    await until(() => dom.evaluate("!document.getElementById('read-only').disabled"), 'tab loaded');
    await dom.evaluate("document.getElementById('read-only').click()");
    await until(() => tab.state.editing.unlocked, 'tab unlocked');
    const index = tab.state.editing.schema.fields.findIndex(field => field.path[0].key.name === 'SessionMaxAge');
    assert.ok(index >= 0);
    assert.deepEqual(tab.state.editing.schema.fields[index].schema, { kind: 'unsignedInteger', min: '0', max: '18446744073709551615' });
    await until(() => dom.evaluate(`!!document.getElementById('edit-${index}')`), 'age input rendered');
    assert.match(await dom.evaluate(`document.getElementById('edit-${index}-range').textContent`), /18446744073709551615/);
    for (const value of ['9007199254740993', '18446744073709551615']) {
      await dom.evaluate(`(() => { const input = document.getElementById('edit-${index}'); input.value = '${value}'; input.dispatchEvent(new Event('input', {bubbles: true})); input.dispatchEvent(new KeyboardEvent('keydown', {key: 'Enter', bubbles: true})); })()`);
      const expected = original.replace('<SessionMaxAge>20', `<SessionMaxAge>${value}`);
      await until(async () => !tab.state.editing.busy && await fs.readFile(file, 'utf8') === expected, 'exact integer saved');
      await until(() => dom.evaluate(`document.getElementById('edit-${index}').value === '${value}'`), 'exact integer displayed');
    }
    await dom.screenshot('session-age-properties.png');
    const beforeInvalid = await fs.readFile(file, 'utf8');
    await dom.evaluate(`(() => { const input = document.getElementById('edit-${index}'); input.value = '18446744073709551616'; input.dispatchEvent(new Event('input', {bubbles: true})); input.dispatchEvent(new KeyboardEvent('keydown', {key: 'Enter', bubbles: true})); })()`);
    await until(() => !tab.state.editing.busy && tab.state.notice.includes('outside the allowed domain'), 'overflow rejected');
    assert.equal(await fs.readFile(file, 'utf8'), beforeInvalid);
    const key = JSON.stringify(tab.state.editing.schema.fields[index].path);
    assert.equal(tab.state.editing.drafts[key].value, '18446744073709551616');
    await dom.evaluate(`document.getElementById('edit-${index}').dispatchEvent(new KeyboardEvent('keydown', {key: 'Escape', bubbles: true}))`);
    await until(() => Object.keys(tab.state.editing.drafts).length === 0, 'draft cancelled');
    for (const value of ['9007199254740993', '20']) {
      await dom.evaluate("document.getElementById('undo').click()");
      await until(async () => !tab.state.editing.busy && await fs.readFile(file, 'utf8') === original.replace('<SessionMaxAge>20', `<SessionMaxAge>${value}`), 'exact integer undo');
    }
    await fs.writeFile(path.join(fixture.root, 'host-result.json'), JSON.stringify({ passed: true, suite: 'property-session-age', vscode: vscode.version }));
  } finally { dom.close(); }
};
