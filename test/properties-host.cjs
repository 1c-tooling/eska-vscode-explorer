const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const vscode = require('vscode');

/** Exercise the contributed action, native picker and final XML selection in VSCodium. */
exports.run = async function () {
  const fixture = JSON.parse(process.env.ESKA_HOST_FIXTURE);
  await vscode.workspace.getConfiguration('eska.explorer').update('executable', process.env.ESKA_TEST_BINARY, vscode.ConfigurationTarget.Workspace);
  const extension = vscode.extensions.all.find(value => value.packageJSON.name === 'eska-explorer');
  const explorer = await extension.activate();
  await vscode.commands.executeCommand('eska.explorer.connect');
  const [root] = (await explorer.getChildren()).filter(entry => entry.node);
  const catalogs = (await explorer.getChildren(root)).find(entry => entry.node.id.collection?.metadataKind === 'catalog');
  const goods = (await explorer.getChildren(catalogs)).find(entry => entry.node.label.text === 'Товары');
  const modules = (await explorer.getChildren(goods)).find(entry => entry.node.id.collection?.kind === 'modules');
  const [module] = await explorer.getChildren(modules);
  assert.equal(explorer.getTreeItem(catalogs).contextValue, 'eskaMetadataGroup');
  assert.equal(explorer.getTreeItem(goods).contextValue, 'eskaMetadata');
  assert.equal(explorer.getTreeItem(module).command.command, 'eska.explorer.openSource');
  const manifest = extension.packageJSON;
  const action = manifest.contributes.menus['view/item/context'].find(item => item.command === 'eska.explorer.properties');
  assert.ok(action.when.includes('viewItem == eskaMetadata'));
  assert.ok(!action.when.includes('eskaMetadataGroup'));
  const opening = vscode.commands.executeCommand(action.command, goods);
  await new Promise(resolve => setTimeout(resolve, 500));
  await vscode.commands.executeCommand('workbench.action.quickOpenSelectNext');
  await vscode.commands.executeCommand('workbench.action.acceptSelectedQuickOpenItem');
  await opening;
  const editor = vscode.window.activeTextEditor;
  assert.equal(editor.document.uri.fsPath, fixture.descriptor);
  assert.equal(editor.document.getText(editor.selection), '<Comment>😀 Кириллица</Comment>');
  await vscode.commands.executeCommand('eska.explorer.disconnect');
  await fs.writeFile(path.join(fixture.root, 'host-result.json'), JSON.stringify({ passed: true, suite: 'properties', vscode: vscode.version }));
};
