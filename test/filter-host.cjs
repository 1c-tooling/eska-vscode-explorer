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
    ? entry.node.label.text : entry.node.label.translations['ru-RU']) === label);
  assert.ok(entry, `Missing ${label}`);
  return entry;
}

/** Test native filter presentation, settings precedence, selection and persistence independently of keyboard smoke tests. */
exports.run = async function () {
  const fixture = JSON.parse(process.env.ESKA_HOST_FIXTURE);
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
  assert.ok(!shown.some(entry => entry.node.label.translations?.['ru-RU'] === 'Константы'));
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
  await vscode.commands.executeCommand('eska.explorer.hideEmptyGroups', root);
  const currentCatalog = named(await explorer.getChildren(root), 'Справочники');
  await explorer.view.reveal(currentCatalog, { select: true, focus: true });
  const rootFile = path.join(fixture.source, 'Configuration.xml');
  const original = await fs.readFile(rootFile, 'utf8');
  const before = root.project.info.generation;
  await fs.writeFile(rootFile, original.replace(/<Catalog>.*?<\/Catalog>/g, ''));
  await until(() => root.project.info.generation !== before, 'root watcher');
  await until(async () => !(await explorer.getChildren(root)).some(entry => entry.node.label.translations?.['ru-RU'] === 'Справочники'), 'last object hides section');
  await until(() => explorer.view.selection[0] === root, 'file change moves hidden selection');
  await fs.writeFile(rootFile, original);
  await until(async () => (await explorer.getChildren(root)).some(entry => entry.node.label.translations?.['ru-RU'] === 'Справочники'), 'added object restores section');
  await vscode.commands.executeCommand('eska.explorer.disconnect');
  await fs.writeFile(path.join(fixture.root, 'host-result.json'), JSON.stringify({ passed: true, suite: 'filter', vscode: vscode.version, node: process.versions.node }));
};
