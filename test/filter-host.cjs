const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const vscode = require('vscode');

/** Wait for a native view/configuration transition without depending on OS keyboard focus. */
async function until(predicate, message) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error(message);
}
/** Match backend-provided Russian labels regardless of the editor locale. */
function named(entries, label) {
  const entry = entries.find(entry => entry.node && (entry.node.label.kind === 'name'
    ? entry.node.label.text : entry.node?.label.translations['ru-RU']) === label);
  assert.ok(entry, `Missing ${label}`);
  return entry;
}

/** Test native filter presentation, settings precedence, selection and persistence independently of keyboard smoke tests. */
exports.run = async function () {
  const fixture = JSON.parse(process.env.ESKA_HOST_FIXTURE);
  const { addCommonModules, descriptor } = await import('./fixture.mjs');
  await addCommonModules(fixture);
  // Roles keeps Common non-empty when the last common module is removed.
  const rootFile = path.join(fixture.source, 'Configuration.xml');
  await fs.mkdir(path.join(fixture.source, 'Roles'), { recursive: true });
  await fs.writeFile(path.join(fixture.source, 'Roles', 'Чтение.xml'), descriptor('Role', 'Чтение'));
  await fs.writeFile(rootFile, (await fs.readFile(rootFile, 'utf8')).replace('<ChildObjects>', '<ChildObjects><Role>Чтение</Role>'));
  const extension = vscode.extensions.all.find(value => value.packageJSON.name === 'eska-explorer');
  assert.ok(extension);
  const config = vscode.workspace.getConfiguration('eska.explorer');
  await config.update('executable', process.env.ESKA_TEST_BINARY, vscode.ConfigurationTarget.Workspace);
  const explorer = await extension.activate();
  await vscode.commands.executeCommand('eska.explorer.connect');
  await vscode.commands.executeCommand('eska.explorer.projects.focus');
  let [root] = await explorer.getChildren();
  assert.equal(explorer.getTreeItem(root).contextValue, 'eskaRootFiltered');
  const shown = await explorer.getChildren(root);
  assert.ok(!shown.some(entry => entry.node?.label.translations?.['ru-RU'] === 'Константы'));
  const common = named(shown, 'Общие');
  const commonShown = await explorer.getChildren(common);
  assert.deepEqual(commonShown.map(entry => entry.node?.label.translations['ru-RU']), ['Общие модули', 'Роли']);
  const commonChildren = common.children;
  const catalog = named(shown, 'Справочники');
  const goods = named(await explorer.getChildren(catalog), 'Товары');
  const forms = named(await explorer.getChildren(goods), 'Формы');
  assert.equal(forms.node.state, 'empty', 'nested empty group remains visible');
  const tree = explorer.tree;
  const children = root.children;
  const generation = root.project.info.generation;
  await vscode.commands.executeCommand('eska.explorer.showEmptyGroups', root);
  const constants = named(await explorer.getChildren(root), 'Константы');
  await explorer.view.reveal(constants, { select: true, focus: true });
  await vscode.commands.executeCommand('eska.explorer.hideEmptyGroups', root);
  await until(() => explorer.view.selection[0] === root, 'hidden selection moves to root');
  assert.equal(root.children, children, 'filter uses cached children');
  assert.equal(explorer.tree, tree);
  assert.equal(root.project.info.generation, generation);
  await vscode.commands.executeCommand('eska.explorer.showEmptyGroups', root);
  const commonForms = named(await explorer.getChildren(common), 'Общие формы');
  await explorer.view.reveal(commonForms, { select: true, focus: true });
  await vscode.commands.executeCommand('eska.explorer.hideEmptyGroups', root);
  await until(() => explorer.view.selection[0] === root, 'hidden Common section selection moves to root');
  assert.equal(common.children, commonChildren, 'Common sections remain cached on toggle');
  assert.equal(root.project.info.generation, generation);
  await config.update('hideEmptyRootGroups', false, vscode.ConfigurationTarget.Global);
  assert.equal(explorer.getTreeItem(root).contextValue, 'eskaRootFiltered', 'project override wins');
  await vscode.commands.executeCommand('eska.explorer.resetRootFilter', root);
  assert.equal(explorer.getTreeItem(root).contextValue, 'eskaRootUnfiltered', 'reset inherits user setting');
  await config.update('hideEmptyRootGroups', true, vscode.ConfigurationTarget.Workspace);
  await until(() => explorer.getTreeItem(root).contextValue === 'eskaRootFiltered', 'workspace setting overrides user setting');
  await vscode.commands.executeCommand('eska.explorer.showEmptyGroups', root);
  await vscode.commands.executeCommand('eska.explorer.restart');
  [root] = await explorer.getChildren();
  assert.equal(explorer.getTreeItem(root).contextValue, 'eskaRootUnfiltered', 'explicit choice survives backend restart');
  named(await explorer.getChildren(root), 'Константы');
  named(await explorer.getChildren(named(await explorer.getChildren(root), 'Общие')), 'Общие формы');
  await vscode.commands.executeCommand('eska.explorer.hideEmptyGroups', root);
  const currentCatalog = named(await explorer.getChildren(root), 'Справочники');
  await explorer.view.reveal(currentCatalog, { select: true, focus: true });
  const original = await fs.readFile(rootFile, 'utf8');
  const before = root.project.info.generation;
  await fs.writeFile(rootFile, original.replace(/<Catalog>.*?<\/Catalog>/g, ''));
  await until(() => root.project.info.generation !== before, 'root watcher');
  await until(async () => !(await explorer.getChildren(root)).some(entry => entry.node?.label.translations?.['ru-RU'] === 'Справочники'), 'last object hides section');
  await until(() => explorer.view.selection[0] === root, 'file change moves hidden selection');
  await fs.writeFile(rootFile, original);
  await until(async () => (await explorer.getChildren(root)).some(entry => entry.node?.label.translations?.['ru-RU'] === 'Справочники'), 'added object restores section');
  const currentCommon = named(await explorer.getChildren(root), 'Общие');
  const modules = named(await explorer.getChildren(currentCommon), 'Общие модули');
  const module = named(await explorer.getChildren(modules), 'Обмен');
  await explorer.view.reveal(module, { select: true, focus: true });
  await fs.writeFile(rootFile, original.replace(/<CommonModule>.*?<\/CommonModule>/g, ''));
  // Do not reload Common from the test: repaint must refresh its summaries before dropping selection.
  await until(() => explorer.view.selection[0] === root, 'last Common object moves descendant selection');
  assert.deepEqual((await explorer.getChildren(currentCommon)).map(entry => entry.node?.label.translations['ru-RU']), ['Роли']);
  await fs.writeFile(rootFile, original);
  await until(async () => (await explorer.getChildren(currentCommon)).some(entry => entry.node?.label.translations?.['ru-RU'] === 'Общие модули'), 'added Common object restores section');
  await explorer.view.reveal(named(await explorer.getChildren(currentCommon), 'Роли'), { select: true, focus: true });
  await fs.writeFile(rootFile, original.replace(/<(CommonModule|Role)>.*?<\/\1>/g, ''));
  await until(() => explorer.view.selection[0] === root, 'empty Common moves descendant selection');
  assert.ok(!(await explorer.getChildren(root)).some(entry => entry.node?.label.translations?.['ru-RU'] === 'Общие'));
  await fs.writeFile(rootFile, original);
  await until(async () => (await explorer.getChildren(root)).some(entry => entry.node?.label.translations?.['ru-RU'] === 'Общие'), 'first Common object restores parent');
  await vscode.commands.executeCommand('eska.explorer.disconnect');
  await fs.writeFile(path.join(fixture.root, 'host-result.json'), JSON.stringify({ passed: true, suite: 'filter', vscode: vscode.version, node: process.versions.node }));
};
