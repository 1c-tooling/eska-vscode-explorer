const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const vscode = require('vscode');

/** Wait for renderer theme changes, without relying on keyboard focus in the desktop session. */
async function until(predicate, message) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error(message);
}
/** Backend labels identify fixture nodes independently of the configured display language. */
function named(entries, label) {
  const entry = entries.find(entry => entry.node && (entry.node.label.kind === 'name'
    ? entry.node.label.text : entry.node?.label.translations['ru-RU']) === label);
  assert.ok(entry, `Missing ${label}`);
  return entry;
}

/** Exercise actual TreeItem SVG paths, repainting and reveal at different themes/zoom levels. */
exports.run = async function () {
  const fixture = JSON.parse(process.env.ESKA_HOST_FIXTURE);
  const extension = vscode.extensions.all.find(value => value.packageJSON.name === 'eska-explorer');
  const { addCommonModules } = await import('./fixture.mjs');
  await addCommonModules(fixture);
  await vscode.workspace.getConfiguration('eska.explorer').update('executable', process.env.ESKA_TEST_BINARY, vscode.ConfigurationTarget.Workspace);
  const explorer = await extension.activate();
  await vscode.commands.executeCommand('eska.explorer.connect');
  await vscode.commands.executeCommand('eska.explorer.projects.focus');
  const [root] = await explorer.getChildren();
  const groups = await explorer.getChildren(root);
  const catalog = named(groups, 'Справочники');
  const goods = named(await explorer.getChildren(catalog), 'Товары');
  const children = await explorer.getChildren(goods);
  const modules = named(children, 'Модули');
  const [module] = await explorer.getChildren(modules);
  const section = named(await explorer.getChildren(named(children, 'Табличные части')), 'Строки');
  const quantity = named(await explorer.getChildren(section), 'Количество');
  const common = named(groups, 'Общие');
  const commonModule = named(await explorer.getChildren(named(await explorer.getChildren(common), 'Общие модули')), 'Обмен');
  const samples = [[root, 'configuration'], [catalog, 'catalog'], [goods, 'catalog'], [modules, 'modules'],
    [module, 'module'], [section, 'tabular-section'], [quantity, 'attribute'], [commonModule, 'common-module']];
  const tree = explorer.tree, session = explorer.connection.state.session.sessionId;
  let repaints = 0;
  const subscription = explorer.onDidChangeTreeData(() => repaints++);
  for (const [name, kind, folder] of [
    ['Default Light Modern', vscode.ColorThemeKind.Light, 'light'],
    ['Default Dark Modern', vscode.ColorThemeKind.Dark, 'dark'],
    ['Default High Contrast', vscode.ColorThemeKind.HighContrast, 'contrast'],
    ['Default High Contrast Light', vscode.ColorThemeKind.HighContrastLight, 'contrast-light'],
  ]) {
    const before = repaints;
    await vscode.workspace.getConfiguration('workbench').update('colorTheme', name, vscode.ConfigurationTarget.Global);
    await until(() => vscode.window.activeColorTheme.kind === kind && repaints > before, `theme ${name}`);
    for (const [entry, icon] of samples) {
      const item = explorer.getTreeItem(entry);
      assert.equal(item.iconPath.fsPath, path.join(extension.extensionPath, 'resources', 'icons', folder, `${icon}.svg`));
      assert.equal((await fs.stat(item.iconPath.fsPath)).isFile(), true);
      assert.equal(explorer.getTreeItem(entry).iconPath, item.iconPath, 'URI cache retained');
      assert.ok(item.accessibilityInformation.label);
    }
    await explorer.view.reveal(quantity, { select: true, focus: false });
    assert.equal(explorer.view.selection[0], quantity);
    assert.equal(explorer.tree, tree);
    assert.equal(explorer.connection.state.session.sessionId, session);
  }
  for (const zoom of [-1, 0, 1, 2]) {
    await vscode.workspace.getConfiguration('window').update('zoomLevel', zoom, vscode.ConfigurationTarget.Global);
    await explorer.view.reveal(commonModule, { select: true, focus: false });
    assert.equal(explorer.getTreeItem(commonModule).collapsibleState, vscode.TreeItemCollapsibleState.None);
  }
  subscription.dispose();
  await vscode.commands.executeCommand('eska.explorer.disconnect');
  await fs.writeFile(path.join(fixture.root, 'host-result.json'), JSON.stringify({ passed: true, suite: 'icons', vscode: vscode.version, node: process.versions.node }));
};
