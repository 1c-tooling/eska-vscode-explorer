const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const vscode = require('vscode');

/** Wait for asynchronous native selection events without assuming reveal delivers them synchronously. */
async function until(predicate) {
  const deadline = Date.now() + 10000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('Native selection did not settle');
    await new Promise(resolve => setTimeout(resolve, 50));
  }
}

/** Locate typed collections independently of the editor's current language. */
function collection(entries, kind) {
  const result = entries.find(entry => entry.node?.id.collection?.metadataKind === kind);
  assert.ok(result, `Missing ${kind}`);
  return result;
}

/** Compare only actual objects, excluding structural groups and workspace files. */
function names(entries) {
  return entries.filter(entry => entry.node?.id.kind === 'object').map(entry => entry.node.label.text);
}

/** Exercise sorting in the native provider for multiple projects and nested lazy branches. */
exports.run = async function () {
  const fixture = JSON.parse(process.env.ESKA_HOST_FIXTURE);
  const { createTreeProject, descriptor } = await import('./fixture.mjs');
  const types = ['configuration', 'extension', 'report', 'processing'];
  for (const type of types) {
    const member = await createTreeProject(path.join(fixture.root, type), type);
    await fs.writeFile(path.join(member.root, 'eska.toml'), `[project]\nname='${type}'\ntype='${type}'\n`);
    const fields = ['Я', 'Поле10', 'Поле2', 'А'].map((name, index) =>
      `<Attribute uuid="22222222-2222-2222-2222-${String(index).padStart(12, '0')}"><Properties><Name>${name}</Name></Properties></Attribute>`).join('');
    const table = `<TabularSection uuid="33333333-3333-3333-3333-333333333333"><Properties><Name>Строки</Name></Properties><ChildObjects>${fields}</ChildObjects></TabularSection>`;
    const kind = type === 'report' ? 'ExternalReport' : type === 'processing' ? 'ExternalDataProcessor' : 'Catalog';
    await fs.writeFile(member.descriptor, descriptor(kind, kind === 'Catalog' ? 'Товары' : 'Тест', fields + table));
  }
  await fs.writeFile(path.join(fixture.root, 'eska.toml'), `[workspace]\nmembers=${JSON.stringify(types)}\n`);
  await vscode.workspace.getConfiguration('eska.explorer').update('executable', process.env.ESKA_TEST_BINARY, vscode.ConfigurationTarget.Workspace);
  await vscode.workspace.getConfiguration('eska.explorer').update('treeLanguage', 'ru-RU', vscode.ConfigurationTarget.Workspace);
  await vscode.workspace.getConfiguration('eska.explorer').update('hideEmptyRootGroups', false, vscode.ConfigurationTarget.Workspace);
  const extension = vscode.extensions.all.find(value => value.packageJSON.name === 'eska-explorer');
  const explorer = await extension.activate();
  await vscode.commands.executeCommand('eska.explorer.connect');
  await vscode.commands.executeCommand('eska.explorer.projects.focus');
  const roots = (await explorer.getChildren()).filter(entry => entry.node);
  assert.equal(roots.length, 4);
  const first = roots.find(entry => entry.project.info.type === 'configuration');
  const second = roots.find(entry => entry.project.info.type === 'extension');
  const groups = await explorer.getChildren(first);
  const catalogs = collection(groups, 'catalog');
  const objects = await explorer.getChildren(catalogs);
  assert.deepEqual(names(objects), ['Товары', 'Покупатели']);
  const goods = objects[0];
  const cached = catalogs.children;
  const session = explorer.connection.state.session.sessionId;
  const tree = explorer.tree;
  const generation = first.project.info.generation;
  await explorer.view.reveal(goods, { select: true, focus: false });
  await until(() => explorer.view.selection[0] === goods);
  await vscode.commands.executeCommand('eska.explorer.sortObjects', first);
  assert.deepEqual(names(await explorer.getChildren(catalogs)), ['Покупатели', 'Товары']);
  assert.equal(catalogs.children, cached);
  assert.equal(explorer.connection.state.session.sessionId, session);
  assert.equal(first.project.info.generation, generation);
  assert.equal(explorer.tree, tree);
  await until(() => explorer.view.selection[0] === goods);
  const label = entry => entry.node.label.kind === 'name' ? entry.node.label.text : entry.node.label.translations['ru-RU'];
  const compare = new Intl.Collator('ru-RU', { sensitivity: 'base', numeric: true }).compare;
  const sorted = (await explorer.getChildren(first)).filter(entry => entry.node);
  assert.deepEqual(sorted, groups.filter(entry => entry.node).sort((a, b) => compare(label(a), label(b))));
  assert.notDeepEqual(sorted, groups.filter(entry => entry.node));
  assert.equal(explorer.getTreeItem(first).contextValue, 'eskaRootUnfilteredSorted');
  const common = sorted.find(entry => entry.node.id.collection?.kind === 'common');
  const commonRows = await explorer.getChildren(common);
  assert.deepEqual(commonRows.map(label), commonRows.map(label).sort(compare));
  await vscode.commands.executeCommand('eska.explorer.hideEmptyGroups', first);
  assert.equal(explorer.getTreeItem(first).contextValue, 'eskaRootFilteredSorted');
  await vscode.commands.executeCommand('eska.explorer.showEmptyGroups', first);
  assert.equal(explorer.getTreeItem(first).contextValue, 'eskaRootUnfilteredSorted');
  const secondCatalogs = collection(await explorer.getChildren(second), 'catalog');
  assert.deepEqual(names(await explorer.getChildren(secondCatalogs)), ['Товары', 'Покупатели']);
  const children = await explorer.getChildren(goods);
  assert.deepEqual(children.map(label), children.map(label).sort(compare));
  const attributes = collection(children, 'attribute');
  assert.deepEqual(names(await explorer.getChildren(attributes)), ['А', 'Поле2', 'Поле10', 'Я']);
  const [section] = await explorer.getChildren(collection(children, 'tabular-section'));
  assert.deepEqual(names(await explorer.getChildren(section)), ['А', 'Поле2', 'Поле10', 'Я']);
  await vscode.commands.executeCommand('eska.explorer.resetSortOrder', first);
  assert.equal(explorer.getTreeItem(first).contextValue, 'eskaRootUnfiltered');
  assert.deepEqual(await explorer.getChildren(first), groups);
  assert.deepEqual(names(await explorer.getChildren(catalogs)), ['Товары', 'Покупатели']);
  assert.deepEqual(names(await explorer.getChildren(attributes)), ['Я', 'Поле10', 'Поле2', 'А']);
  assert.deepEqual(names(await explorer.getChildren(section)), ['Я', 'Поле10', 'Поле2', 'А']);
  for (const root of roots.filter(entry => ['report', 'processing'].includes(entry.project.info.type))) {
    assert.equal(explorer.getTreeItem(root).contextValue, 'eskaRoot');
    const group = collection(await explorer.getChildren(root), 'attribute');
    await vscode.commands.executeCommand('eska.explorer.sortObjects', root);
    assert.deepEqual(names(await explorer.getChildren(group)), ['А', 'Поле2', 'Поле10', 'Я']);
  }
  await vscode.commands.executeCommand('eska.explorer.sortObjects', first);
  await vscode.commands.executeCommand('eska.explorer.restart');
  const restarted = (await explorer.getChildren()).filter(entry => entry.node);
  for (const root of restarted) {
    assert.equal(explorer.sorting.order(root.project), root.project.info.type === 'extension' ? 'original' : 'alphabetical');
  }
  await vscode.commands.executeCommand('eska.explorer.disconnect');
  await fs.writeFile(path.join(fixture.root, 'host-result.json'), JSON.stringify({ passed: true, suite: 'sorting', projects: 4, vscode: vscode.version }));
};
