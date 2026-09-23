const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const vscode = require('vscode');

/** Wait for an observed asynchronous UI/filesystem transition, with a bounded diagnostic failure. */
async function until(predicate, message) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error(message);
}
/** Locate the intended backend label in the native provider. */
function named(elements, label) {
  const entry = elements.find(entry => entry.node && (entry.node.label.kind === 'name'
    ? entry.node.label.text : entry.node?.label.translations['ru-RU']) === label);
  assert.ok(entry, `Missing ${label}`);
  return entry;
}

/** Exercise native reveal/selection/editor behavior against the real filesystem watcher and backend. */
exports.run = async function () {
  const fixture = JSON.parse(process.env.ESKA_HOST_FIXTURE);
  const extension = vscode.extensions.all.find(value => value.packageJSON.name === 'eska-explorer');
  assert.ok(extension);
  await vscode.workspace.getConfiguration('eska.explorer').update('executable', process.env.ESKA_TEST_BINARY, vscode.ConfigurationTarget.Workspace);
  const xmlWithSynonym = (await fs.readFile(fixture.descriptor, 'utf8')).replace('<Name>Артикул</Name>',
    '<Name>Артикул</Name><Synonym xmlns:v8="http://v8.1c.ru/8.1/data/core"><v8:item><v8:lang>ru</v8:lang><v8:content>Уникальный код товара</v8:content></v8:item></Synonym>');
  await fs.writeFile(fixture.descriptor, xmlWithSynonym);
  const { addCommonModules } = await import("./fixture.mjs");
  await addCommonModules(fixture);
  const explorer = await extension.activate();
  /** The native tree exposes configuration nodes only after the support pass completes. */
  async function children(entry) {
    await until(() => !explorer.support.loading, 'support preloader completed');
    return explorer.getChildren(entry);
  }
  await vscode.commands.executeCommand('eska.explorer.disconnect');
  // Disconnect must also invalidate preflight, before Connection owns a child.
  const ensure = explorer.setup.ensure.bind(explorer.setup);
  let releaseProbe;
  explorer.setup.ensure = () => new Promise(resolve => { releaseProbe = resolve; });
  const opening = vscode.commands.executeCommand('eska.explorer.connect');
  await until(() => releaseProbe, 'preflight started');
  await vscode.commands.executeCommand('eska.explorer.disconnect');
  releaseProbe(process.env.ESKA_TEST_BINARY);
  await opening;
  assert.equal(explorer.connection.state.kind, 'disconnected');
  assert.equal(explorer.connection.child, undefined);
  explorer.setup.ensure = ensure;
  await vscode.commands.executeCommand('eska.explorer.connect');
  await vscode.commands.executeCommand('eska.explorer.projects.focus');
  assert.equal(explorer.status.text, `ESKA v${explorer.connection.state.version}`);
  assert.ok(explorer.status.tooltip.includes(explorer.connection.state.version));
  assert.ok(explorer.status.tooltip.includes(explorer.connection.state.target.executable));
  assert.equal(explorer.status.command, 'eska.explorer.checkUpdates');
  const checkUpdates = explorer.setup.check;
  let manualCheck;
  explorer.setup.check = async manual => { manualCheck = manual; };
  try { await vscode.commands.executeCommand(explorer.status.command); }
  finally { explorer.setup.check = checkUpdates; }
  assert.equal(manualCheck, true, 'status bar invokes the manual update check');
  assert.ok(!explorer.view.message, 'connection status does not occupy the tree');
  const top = await children();
  const [root] = top;
  const settings = top.find(row => row.kind === 'settings');
  assert.ok(settings, 'standalone settings are beside the configuration');
  assert.equal(explorer.getParent(settings), undefined);
  assert.ok((await children(root)).every(row => row.node), 'no synthetic structure or file groups in standalone metadata');
  const catalogs = named(await children(root), 'Справочники');
  assert.equal(explorer.getParent(catalogs), root);
  const objects = await children(catalogs);
  const goods = named(objects, 'Товары');
  const customers = named(objects, 'Покупатели');
  assert.equal(goods.children, undefined, 'listing does not expand descriptors');
  // Synonym matching remains visible in native Quick Pick; Enter reveals an initially unopened branch.
  await vscode.commands.executeCommand('eska.explorer.search');
  const search = explorer.searchView;
  // The desktop may lose OS focus while automation runs; this test exercises search, not blur dismissal.
  search.picker.ignoreFocusOut = true;
  search.picker.value = 'уНиКаЛьНыЙ код';
  try {
    await until(() => search.picker.items.some(item => item.hit?.name === 'Артикул') && !search.picker.busy, 'synonym search');
  } catch (error) {
    throw new Error(`${error.message}: ${JSON.stringify({ value: search.picker.value, busy: search.picker.busy,
      text: search.session.snapshot.text, loading: search.session.snapshot.loading, disposed: search.disposed, current: explorer.searchView === search,
      projects: search.session.snapshot.projects.map(row => ({ progress: row.progress, error: row.error?.code, hits: row.hits.map(hit => hit.name) })) })}`);
  }
  const searchSession = explorer.connection.state.session.sessionId;
  for (const language of ['ru-RU', 'en-US', 'auto']) {
    await vscode.workspace.getConfiguration('eska.explorer').update('treeLanguage', language, vscode.ConfigurationTarget.Workspace);
    const russian = language === 'ru-RU' || (language === 'auto' && vscode.env.language.toLowerCase().startsWith('ru'));
    await until(() => search.picker.items.find(item => item.hit)?.description.startsWith(russian ? 'Реквизит ·' : 'Attribute ·'), 'localized search kind');
    assert.equal(explorer.connection.state.session.sessionId, searchSession, 'locale keeps search connection');
  }
  const result = search.picker.items.find(item => item.hit);
  assert.equal(result.hit.name, 'Артикул');
  assert.ok(result.detail.includes('Товары'));
  assert.ok(result.detail.includes('Уникальный код товара'));
  await vscode.commands.executeCommand('workbench.action.acceptSelectedQuickOpenItem');
  await until(() => !explorer.searchView && explorer.view.selection[0]?.node.label.text === 'Артикул', 'search Enter/reveal');
  await vscode.commands.executeCommand('eska.explorer.search');
  explorer.searchView.picker.value = 'нетТакогоОбъекта';
  await until(() => !explorer.searchView.picker.busy && explorer.searchView.picker.items.some(item => /No matches|Совпадений нет/.test(item.label)), 'no matches');
  await vscode.commands.executeCommand('workbench.action.closeQuickOpen');
  await until(() => !explorer.searchView, 'search Escape');
  await explorer.view.reveal(goods, { expand: true, select: true, focus: true });
  const groups = await children(goods);
  const modules = named(groups, 'Модули');
  assert.equal(groups[0], modules);
  assert.equal(explorer.getTreeItem(modules).collapsibleState, vscode.TreeItemCollapsibleState.Expanded);
  const scripts = await children(modules);
  assert.equal(scripts.length, 1, 'bin-only manager is hidden');
  const attributes = named(groups, 'Реквизиты');
  const article = named(await children(attributes), 'Артикул');
  await explorer.view.reveal(article, { select: true, focus: true });
  await vscode.commands.executeCommand('eska.explorer.openSource', article);
  assert.equal(vscode.window.activeTextEditor.document.uri.fsPath, fixture.descriptor);
  assert.equal(vscode.window.activeTextEditor.document.getText(vscode.window.activeTextEditor.selection), '<Name>Артикул</Name>');
  await vscode.commands.executeCommand('eska.explorer.openSource', scripts[0]);
  assert.equal(vscode.window.activeTextEditor.document.uri.fsPath, fixture.module);

  const common = named(await children(root), 'Общие');
  const commonGroup = named(await children(common), 'Общие модули');
  const commonModule = named(await children(commonGroup), 'Обмен');
  const commonItem = explorer.getTreeItem(commonModule);
  assert.equal(commonItem.collapsibleState, vscode.TreeItemCollapsibleState.None);
  assert.equal(commonItem.contextValue, 'eskaCommonModule');
  assert.deepEqual(await children(commonModule), []);
  await explorer.view.reveal(commonModule, { select: true, focus: true });
  await vscode.commands.executeCommand(commonItem.command.command, ...commonItem.command.arguments);
  assert.equal(vscode.window.activeTextEditor.document.uri.fsPath, path.join(fixture.source, 'CommonModules', 'Обмен', 'Ext', 'Module.bsl'));
  await vscode.commands.executeCommand('eska.explorer.openXml', commonModule);
  assert.equal(vscode.window.activeTextEditor.document.uri.fsPath, path.join(fixture.source, 'CommonModules', 'Обмен.xml'));
  assert.equal(vscode.window.activeTextEditor.document.getText(vscode.window.activeTextEditor.selection), '<Name>Обмен</Name>');

  // A user collapse must survive a branch refresh, despite expandedByDefault on the backend.
  await vscode.commands.executeCommand('eska.explorer.projects.focus');
  await explorer.view.reveal(modules, { select: true, focus: true, expand: true });
  await vscode.commands.executeCommand('list.collapse');
  await until(() => explorer.getTreeItem(modules).collapsibleState === vscode.TreeItemCollapsibleState.Collapsed, 'module collapse event');
  await explorer.view.reveal(customers, { select: true, focus: true, expand: true });
  const selected = explorer.view.selection[0].key;
  // Language changes repaint cached labels without reconnecting or losing native tree state.
  const languageTree = explorer.tree;
  const sessionId = explorer.connection.state.session.sessionId;
  const moduleId = explorer.getTreeItem(modules).id;
  let repaints = 0;
  const repaintSubscription = explorer.onDidChangeTreeData(() => { repaints++; });
  for (const language of ['ru-RU', 'en-US', 'auto']) {
    const previousRepaints = repaints;
    await vscode.workspace.getConfiguration('eska.explorer').update('treeLanguage', language, vscode.ConfigurationTarget.Workspace);
    await until(() => repaints > previousRepaints, 'language repaint');
    const locale = language === 'auto' ? (vscode.env.language.toLowerCase().startsWith('ru') ? 'ru-RU' : 'en-US') : language;
    assert.equal(explorer.getTreeItem(modules).label, locale === 'ru-RU' ? 'Модули' : 'Modules');
    assert.equal(explorer.getTreeItem(scripts[0]).label, scripts[0].node.label.translations[locale]);
    assert.equal(explorer.getTreeItem(goods).label, 'Товары');
    assert.equal(explorer.getTreeItem(modules).id, moduleId);
    assert.equal(explorer.getTreeItem(modules).collapsibleState, vscode.TreeItemCollapsibleState.Collapsed);
    assert.equal(explorer.tree, languageTree);
    assert.equal(explorer.connection.state.session.sessionId, sessionId);
    assert.equal((await children(modules))[0], scripts[0], 'reuse cached module nodes');
    await explorer.view.reveal(customers, { select: false });
    assert.equal(explorer.view.selection[0].key, selected);
  }
  repaintSubscription.dispose();
  const original = await fs.readFile(fixture.descriptor, 'utf8');
  const generation = goods.project.info.generation;
  await fs.writeFile(fixture.descriptor, original.replace('<Name>Артикул</Name>', '<Name>НовыйАртикул</Name>'));
  await until(() => goods.project.info.generation !== generation, 'external file watcher invalidation');
  const updatedGroups = await children(goods);
  named(await children(named(updatedGroups, 'Реквизиты')), 'НовыйАртикул');
  await until(() => explorer.view.selection[0]?.key === selected, 'unrelated selection retained after native refresh');
  assert.equal(explorer.getTreeItem(named(updatedGroups, 'Модули')).collapsibleState, vscode.TreeItemCollapsibleState.Collapsed);

  const beforeBroken = goods.project.info.generation;
  await fs.writeFile(fixture.descriptor, '<broken');
  await until(() => goods.project.info.generation !== beforeBroken, 'broken file invalidation');
  const errors = await children(goods);
  assert.equal(errors.length, 1);
  assert.ok(!errors[0].node && errors[0].parent === goods, 'local error row');
  assert.ok((await children(customers)).some(entry => entry.node), 'other branch remains usable');
  const beforeFixed = goods.project.info.generation;
  await fs.writeFile(fixture.descriptor, original);
  await until(() => goods.project.info.generation !== beforeFixed, 'fixed file invalidation');
  named(await children(goods), 'Реквизиты');

  // Native tree presentation works with all built-in theme families and editor zoom.
  for (const theme of ['Default Light Modern', 'Default Dark Modern', 'Default High Contrast']) {
    await vscode.workspace.getConfiguration('workbench').update('colorTheme', theme, vscode.ConfigurationTarget.Global);
    assert.ok(explorer.getTreeItem(goods).accessibilityInformation.label);
    await explorer.view.reveal(goods, { select: true, focus: true });
  }
  await vscode.commands.executeCommand('workbench.action.zoomIn');
  await vscode.commands.executeCommand('workbench.action.zoomReset');
  await vscode.commands.executeCommand('eska.explorer.refreshNode', goods);
  assert.equal(explorer.getTreeItem(named(await children(goods), 'Модули')).collapsibleState, vscode.TreeItemCollapsibleState.Collapsed);
  // Filter toggles reuse loaded nodes; a selected hidden descendant falls back to the root.
  const filterTree = explorer.tree;
  const filterGeneration = root.project.info.generation;
  const filterChildren = root.children;
  assert.equal(explorer.getTreeItem(root).contextValue, 'eskaRootFiltered');
  assert.ok(!(await children(root)).some(entry => entry.node?.label.translations?.['ru-RU'] === 'Константы'));
  await vscode.commands.executeCommand('eska.explorer.showEmptyGroups', root);
  const constants = named(await children(root), 'Константы');
  // TreeDataProvider refresh is asynchronous; await native visibility after the filter command.
  await until(async () => {
    try { await explorer.view.reveal(constants, { select: true, focus: true }); return true; }
    catch { return false; }
  }, 'native filter redraw');
  await vscode.commands.executeCommand('eska.explorer.hideEmptyGroups', root);
  await until(() => explorer.view.selection[0] === root, 'hidden section selection moves to root');
  assert.equal(explorer.tree, filterTree);
  assert.equal(root.children, filterChildren, 'toggling does not reload root children');
  assert.equal(root.project.info.generation, filterGeneration);
  await vscode.workspace.getConfiguration('eska.explorer').update('hideEmptyRootGroups', false, vscode.ConfigurationTarget.Workspace);
  assert.equal(explorer.getTreeItem(root).contextValue, 'eskaRootFiltered', 'saved project choice overrides default');
  await vscode.commands.executeCommand('eska.explorer.resetRootFilter', root);
  assert.equal(explorer.getTreeItem(root).contextValue, 'eskaRootUnfiltered', 'reset uses workspace setting');
  named(await children(root), 'Константы');
  await vscode.workspace.getConfiguration('eska.explorer').update('hideEmptyRootGroups', true, vscode.ConfigurationTarget.Workspace);
  await until(() => explorer.getTreeItem(root).contextValue === 'eskaRootFiltered', 'default setting updates inherited filter');
  await vscode.commands.executeCommand('eska.explorer.showEmptyGroups', root);

  assert.equal(explorer.getTreeItem(modules).collapsibleState, vscode.TreeItemCollapsibleState.Collapsed, 'filter keeps explicit collapse');
  console.log("ESKA_HOST_BASE_SCENARIOS_PASSED");
  // A broken root must settle on an error, not keep retrying on every tree repaint.
  const rootFile = path.join(fixture.source, 'Configuration.xml');
  const rootXml = await fs.readFile(rootFile, 'utf8');
  await fs.writeFile(rootFile, '<broken');
  await until(() => root.project.info.requiresRefresh, 'root invalidation');
  await until(async () => !(await children())[0].node, 'root error row');
  await new Promise(resolve => setTimeout(resolve, 400));
  const failedGeneration = root.project.info.generation;
  await children();
  await new Promise(resolve => setTimeout(resolve, 300));
  assert.equal(root.project.info.generation, failedGeneration, 'broken root does not cause a retry loop');
  await fs.writeFile(rootFile, rootXml);
  await until(() => !root.project.info.requiresRefresh, 'root correction refresh');
  assert.ok((await children())[0].node);

  console.log("ESKA_HOST_ROOT_RECOVERY_PASSED");
  const previousTree = explorer.tree;
  await fs.appendFile(path.join(fixture.root, 'eska.toml'), '\n# External manifest update\n');
  await until(() => explorer.tree && explorer.tree !== previousTree, 'manifest reconnect');
  const [reconnectedRoot] = await children();
  assert.equal(explorer.getTreeItem(reconnectedRoot).contextValue, 'eskaRootUnfiltered', 'project filter survives reconnect');
  named(await children(reconnectedRoot), 'Константы');
  await vscode.commands.executeCommand('eska.explorer.search');
  await vscode.commands.executeCommand('eska.explorer.disconnect');
  assert.equal(explorer.searchView, undefined, 'disconnect disposes search input');
  assert.equal(explorer.status.text, '', 'disconnect clears the connected version');
  assert.equal(explorer.status.tooltip, undefined, 'disconnect clears the connected binary');
  await fs.writeFile(path.join(fixture.root, 'host-result.json'), JSON.stringify({ passed: true, vscode: vscode.version, node: process.versions.node }));
  console.log('ESKA_TREE_HOST_PASSED', vscode.version);
};
