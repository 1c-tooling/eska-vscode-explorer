const vscode = require('vscode');
const fs = require('node:fs/promises');
const path = require('node:path');
const assert = require('node:assert/strict');
const { frame } = require('./webview-host.cjs');

/** Wait for the specific schema or write acknowledgement rather than sleeping through an autosave. */
async function until(condition, label) {
  for (let i = 0; i < 100; i++) { if (await condition()) return; await new Promise(resolve => setTimeout(resolve, 50)); }
  throw new Error(label);
}

/** The native controls must refresh their bounds after a dependent enum changes and retain invalid drafts. */
exports.run = async function () {
  const fixture = JSON.parse(process.env.ESKA_HOST_FIXTURE);
  const file = path.join(fixture.source, 'Catalogs/Товары.xml');
  const original = (await fs.readFile(file, 'utf8')).replace('</Properties>', '<CodeType>String</CodeType><CodeLength>9</CodeLength></Properties>');
  await fs.writeFile(file, original);
  await fs.mkdir(path.join(fixture.source, 'Ext'), { recursive: true });
  await fs.writeFile(path.join(fixture.source, 'Ext/ParentConfigurations.bin'), '{6,0,0,0,0,0}');
  await vscode.workspace.getConfiguration('eska.explorer').update('executable', process.env.ESKA_TEST_BINARY, vscode.ConfigurationTarget.Workspace);
  const explorer = await vscode.extensions.all.find(item => item.packageJSON.name === 'eska-explorer').activate();
  await vscode.commands.executeCommand('eska.explorer.connect');
  const [root] = (await explorer.getChildren()).filter(entry => entry.node);
  const group = (await explorer.getChildren(root)).find(entry => entry.node.id.collection?.metadataKind === 'catalog');
  const entry = (await explorer.getChildren(group)).find(entry => entry.node.label.text === 'Товары');
  await vscode.commands.executeCommand('eska.explorer.properties', entry);
  const [tab] = explorer.propertiesTabs.tabs.values();
  const dom = await frame(tab);
  try {
    await dom.evaluate("document.getElementById('read-only').click()");
    await until(() => tab.state.editing.unlocked, 'unlock');
    const index = tab.state.editing.schema.fields.findIndex(field => field.path[0].key.name === 'CodeLength');
    const control = `document.getElementById('edit-${index}')`;
    await until(() => dom.evaluate(`Boolean(${control})`), 'integer control');
    assert.equal(await dom.evaluate(`document.getElementById(${control}.getAttribute('aria-describedby')).textContent`), 'Integer from 0 to 50');
    await dom.evaluate(`(()=>{const input=${control}; input.value='38';input.dispatchEvent(new Event('input'));input.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}));})()`);
    await until(async () => !tab.state.editing.busy && (await fs.readFile(file,'utf8')).includes('<CodeLength>38</CodeLength>'), 'length autosave');
    const type = tab.state.editing.schema.fields.findIndex(field => field.path[0].key.name === 'CodeType');
    await dom.evaluate(`(()=>{const input=document.getElementById('edit-${type}');input.value='Number';input.dispatchEvent(new Event('change'));})()`);
    await until(() => !tab.state.editing.busy && tab.state.editing.schema.fields[index].schema.max === 38, 'dependent domain');
    await until(() => dom.evaluate(`document.getElementById(${control}.getAttribute('aria-describedby')).textContent==='Integer from 0 to 38'`), 'new range hint');
    const saved = await fs.readFile(file,'utf8');
    assert.equal(saved, original.replace('<CodeLength>9</CodeLength>', '<CodeLength>38</CodeLength>').replace('<CodeType>String</CodeType>','<CodeType>Number</CodeType>'));
    await dom.evaluate(`(()=>{const input=${control};input.value='39';input.dispatchEvent(new Event('input'));input.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}));})()`);
    await until(() => !tab.state.editing.busy && tab.state.notice.includes('outside'), 'invalid input retained');
    assert.equal(await fs.readFile(file,'utf8'), saved);
    assert.equal(Object.values(tab.state.editing.drafts)[0].value, '39');
    await dom.evaluate(`${control}.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))`);
    await until(() => Object.keys(tab.state.editing.drafts).length === 0, 'cancel invalid draft');
    assert.equal(tab.state.notice.includes('outside'), false, 'cancel removes the obsolete validation error');
    assert.equal(await dom.evaluate('document.documentElement.scrollWidth > innerWidth'), false);
    await dom.screenshot('integer-properties.png');
    await fs.writeFile(path.join(fixture.root,'host-result.json'),JSON.stringify({passed:true,suite:'property-integers',vscode:vscode.version}));
  } finally { dom.close(); }
};
