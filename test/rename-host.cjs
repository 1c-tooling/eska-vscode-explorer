const vscode = require('vscode');
const fs = require('node:fs/promises');
const path = require('node:path');
const assert = require('node:assert/strict');
const { frame, until } = require('./webview-host.cjs');

/** Exercise input, review, navigation, confirmed publication and identity-preserving undo in VSCodium. */
exports.run = async function () {
  const fixture = JSON.parse(process.env.ESKA_HOST_FIXTURE);
  await fs.rm(path.join(fixture.source, 'Catalogs/Товары/Ext/ManagerModule.bin'));
  await fs.mkdir(path.join(fixture.source, 'Ext'), { recursive: true });
  await fs.writeFile(path.join(fixture.source, 'Ext/ParentConfigurations.bin'), '{6,0,0,0,0,0}');
  const codePath = path.join(fixture.source, 'Ext/SessionModule.bsl');
  const code = '\ufeffA = Catalogs.Товары;\r\nB = "Товары";\r\n';
  await fs.writeFile(codePath, code);
  const original = await fs.readFile(fixture.descriptor, 'utf8');
  await vscode.workspace.getConfiguration('eska.explorer').update('executable', process.env.ESKA_TEST_BINARY, vscode.ConfigurationTarget.Workspace);
  const extension = vscode.extensions.all.find(item => item.packageJSON.name === 'eska-explorer');
  const explorer = await extension.activate();
  await vscode.commands.executeCommand('eska.explorer.connect');
  const [root] = (await explorer.getChildren()).filter(entry => entry.node);
  await until(() => !explorer.support.loading, 'support ready');
  const catalogs = (await explorer.getChildren(root)).find(entry => entry.node?.id.collection?.metadataKind === 'catalog');
  const object = (await explorer.getChildren(catalogs)).find(entry => entry.node.label.text === 'Товары');
  await vscode.commands.executeCommand('eska.explorer.properties', object);
  const [tab] = explorer.propertiesTabs.tabs.values();
  let dom = await frame(tab);
  try {
    await dom.evaluate("document.getElementById('read-only').click()");
    await until(() => tab.state.editing.unlocked && tab.state.editing.schema.renameAvailable, 'rename unlock');
    await dom.evaluate("[...document.querySelectorAll('button')].find(button=>button.textContent==='Rename').click()");
    await until(() => dom.workbench("document.querySelector('.quick-input-title')?.textContent==='Rename'"), 'rename input');
    await dom.workbench("(()=>{const input=document.querySelector('.quick-input-widget input[type=text]');input.value='Материалы';input.dispatchEvent(new Event('input',{bubbles:true}));})()");
    await vscode.commands.executeCommand('workbench.action.acceptSelectedQuickOpenItem');
    const preview = await frame({ state: { title: 'Товары → Материалы' } });
    try {
      assert.equal(await preview.evaluate("document.getElementById('apply').disabled"), true);
      assert.match(await preview.evaluate("document.getElementById('summary').textContent"), /Confirmed replacements: 3.*Moves: 2.*review: 1/);
      assert.equal(await preview.evaluate("document.documentElement.scrollWidth > innerWidth"), false);
      await preview.evaluate("document.querySelector('.uncertain').parentElement.querySelector('button').click()");
      await until(() => vscode.window.activeTextEditor?.document.uri.fsPath === codePath, 'uncertain source navigation');
      assert.ok(vscode.window.activeTextEditor.document.getText(vscode.window.activeTextEditor.selection).includes('Товары'));
      await preview.screenshot('rename-review.png');
      await preview.evaluate("document.getElementById('reviewed').click();document.getElementById('apply').click()");
    } finally { preview.close(); }
    const renamedFile = path.join(fixture.source, 'Catalogs/Материалы.xml');
    await until(async () => !tab.state.editing.busy && (await fs.readFile(renamedFile, 'utf8').catch(() => '')) === original.replace('<Name>Товары</Name>', '<Name>Материалы</Name>'), 'rename autosave');
    assert.equal(tab.entry.node.id.objectId, 'catalog:Материалы');
    assert.equal(tab.state.title, 'Материалы');
    assert.equal(await fs.readFile(codePath, 'utf8'), code.replace('Catalogs.Товары', 'Catalogs.Материалы'));
    await until(() => vscode.workspace.textDocuments.some(document => document.uri.fsPath === codePath && !document.isDirty
      && document.getText() === code.replace(/^\ufeff/, '').replace('Catalogs.Товары', 'Catalogs.Материалы')), 'open code document reloaded');
    await vscode.commands.executeCommand('eska.explorer.properties', tab.entry);
    assert.equal(explorer.propertiesTabs.tabs.size, 1);
    dom.close(); dom = await frame(tab);
    await dom.screenshot('renamed-properties.png');
    await dom.evaluate("document.getElementById('undo').click()");
    await until(async () => !tab.state.editing.busy && (await fs.readFile(fixture.descriptor, 'utf8').catch(() => '')) === original, 'rename undo');
    assert.equal(tab.entry.node.id.objectId, 'catalog:Товары');
    assert.equal(await fs.readFile(codePath, 'utf8'), code);
    await until(() => !tab.state.editing.busy, 'undo reread');
    await dom.evaluate("document.getElementById('redo').click()");
    await until(async () => !tab.state.editing.busy && (await fs.readFile(renamedFile, 'utf8').catch(() => '')) === original.replace('<Name>Товары</Name>', '<Name>Материалы</Name>'), 'rename redo');
    await fs.writeFile(path.join(fixture.root, 'host-result.json'), JSON.stringify({ passed: true, suite: 'metadata-rename', vscode: vscode.version }));
  } finally { dom.close(); }
};
