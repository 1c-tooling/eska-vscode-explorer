const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const vscode = require('vscode');

/** Wait for a specific UI/watcher condition without depending on an arbitrary fixed delay. */
async function until(predicate, message) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error(message);
}
/** Locate a node by its displayed fixture name or Russian collection label. */
function named(rows, text) {
  const value = rows.find(row => row.node && (row.node.label.text ?? row.node.label.translations?.['ru-RU']) === text);
  assert.ok(value, `Missing ${text}`);
  return value;
}
/** Confirm search reveal, hierarchy, precise XML navigation, locale and live file updates. */
exports.run = async function () {
  const fixture = JSON.parse(process.env.ESKA_HOST_FIXTURE);
  const file = path.join(fixture.source, 'Catalogs', 'Товары', 'Ext', 'Predefined.xml');
  const xml = '\ufeff<?xml version="1.0" encoding="UTF-8"?>\r\n<PredefinedData xmlns="http://v8.1c.ru/8.3/xcf/predef"><Item id="folder"><Name>ГруппаДанных</Name><Description>😀 Группа</Description><IsFolder>true</IsFolder><ChildItems><Item id="child"><Name>ЭлементДанных</Name><Code>01</Code><Description>Нужное описание</Description></Item></ChildItems></Item></PredefinedData>';
  await fs.writeFile(file, xml);
  const settings = vscode.workspace.getConfiguration('eska.explorer');
  await settings.update('executable', process.env.ESKA_TEST_BINARY, vscode.ConfigurationTarget.Workspace);
  await settings.update('treeLanguage', 'ru-RU', vscode.ConfigurationTarget.Workspace);
  const extension = vscode.extensions.all.find(value => value.packageJSON.name === 'eska-explorer');
  const explorer = await extension.activate();
  await vscode.commands.executeCommand('eska.explorer.connect');
  await vscode.commands.executeCommand('eska.explorer.search');
  explorer.searchView.picker.ignoreFocusOut = true;
  explorer.searchView.picker.value = 'Нужное описание';
  await until(() => explorer.searchView.picker.items.some(item => item.hit?.name === 'ЭлементДанных') && !explorer.searchView.picker.busy, 'predefined description search');
  const result = explorer.searchView.picker.items.find(item => item.hit?.name === 'ЭлементДанных');
  assert.match(result.description, /^Предопределённый элемент/);
  await vscode.commands.executeCommand('workbench.action.acceptSelectedQuickOpenItem');
  await until(() => !explorer.searchView && explorer.view.selection[0]?.node.label.text === 'ЭлементДанных', 'reveal unopened predefined item');
  const item = explorer.view.selection[0];
  const folder = explorer.getParent(item);
  const group = explorer.getParent(folder);
  const owner = explorer.getParent(group);
  assert.equal(folder.node.label.text, 'ГруппаДанных');
  assert.equal(explorer.getTreeItem(group).label, 'Предопределённые данные');
  const siblings = await explorer.getChildren(owner);
  assert.equal(siblings[1], group, 'predefined collection follows modules');
  const command = explorer.getTreeItem(item).command;
  await vscode.commands.executeCommand(command.command, ...command.arguments);
  assert.equal(vscode.window.activeTextEditor.document.uri.fsPath, file);
  assert.equal(vscode.window.activeTextEditor.document.getText(vscode.window.activeTextEditor.selection), '<Name>ЭлементДанных</Name>');
  assert.match(explorer.getTreeItem(item).iconPath.path, /\/enum\.svg$/);
  await settings.update('treeLanguage', 'en-US', vscode.ConfigurationTarget.Workspace);
  await until(() => explorer.getTreeItem(group).label === 'Predefined data', 'English predefined label');
  await fs.writeFile(file, xml.replaceAll('ЭлементДанных', 'НовыйЭлемент'));
  await until(async () => {
    const updatedGroup = named(await explorer.getChildren(owner), 'Предопределённые данные');
    const children = await explorer.getChildren(updatedGroup);
    if (!children[0]?.node) return false;
    return (await explorer.getChildren(children[0])).some(row => row.node?.label.text === 'НовыйЭлемент');
  }, 'predefined watcher rename');
  await fs.rm(file);
  await until(async () => {
    const updatedGroup = named(await explorer.getChildren(owner), 'Предопределённые данные');
    return (await explorer.getChildren(updatedGroup)).length === 0;
  }, 'predefined watcher deletion');
  await fs.writeFile(path.join(fixture.root, 'host-result.json'), JSON.stringify({passed: true, searchReveal: true, xmlSelection: true, languages: 2, watcher: true}));
};
