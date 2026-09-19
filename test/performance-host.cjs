const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const vscode = require('vscode');

/** Wait for a complete provider/UI result rather than assuming a renderer delay. */
async function until(predicate, message, timeout = 120000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (await predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  throw new Error(message);
}
/** Identify collections from typed protocol fields, independent of locale. */
function group(entries, kind) {
  const result = entries.find(entry => entry.node?.id.collection?.metadataKind === kind
    || entry.node?.id.collection?.kind === kind);
  assert.ok(result, `Missing group ${kind}`);
  return result;
}
/** Record milliseconds including asynchronous native API completion. */
async function timed(operation) {
  const start = performance.now();
  const value = await operation();
  return [value, performance.now() - start];
}
/** Linux peak RSS includes native allocations; current RSS allows comparison across reconnects. */
async function memory(pid) {
  const value = await fs.readFile(`/proc/${pid}/status`, 'utf8');
  return Object.fromEntries(['VmRSS', 'VmHWM'].map(key => [key, Number(value.match(new RegExp(`${key}:\\s+(\\d+)`))[1]) / 1024]));
}
/** Run real native-provider sessions on an explicitly supplied read-only large project. */
exports.run = async function () {
  assert.equal(process.platform, 'linux', 'RSS sampler requires Linux');
  assert.ok(process.env.ESKA_PERF_PROJECT, 'Set ESKA_PERF_PROJECT explicitly');
  const fixture = JSON.parse(process.env.ESKA_HOST_FIXTURE);
  const extension = vscode.extensions.all.find(value => value.packageJSON.name === 'eska-explorer');
  await vscode.workspace.getConfiguration('eska.explorer').update('executable', process.env.ESKA_TEST_BINARY, vscode.ConfigurationTarget.Global);
  const explorer = await extension.activate();
  await vscode.commands.executeCommand('eska.explorer.disconnect');
  const rounds = [];
  for (let round = 0; round < 5; round++) {
    const [, connect] = await timed(() => vscode.commands.executeCommand('eska.explorer.connect'));
    const pid = explorer.connection.child.pid;
    const [[root], rootMs] = await timed(() => explorer.getChildren());
    await vscode.commands.executeCommand('eska.explorer.projects.focus');
    const [sections, sectionsMs] = await timed(() => explorer.getChildren(root));
    const common = group(sections, 'common');
    const modules = group(await explorer.getChildren(common), 'common-module');
    const [moduleRows, modulesMs] = await timed(async () => {
      const rows = await explorer.getChildren(modules);
      rows.forEach(entry => explorer.getTreeItem(entry));
      await explorer.view.reveal(rows[rows.length - 1], { select: true, focus: false });
      return rows;
    });
    assert.equal(moduleRows.length, 3808);
    const reportRows = await explorer.getChildren(group(sections, 'report'));
    const report = reportRows.find(entry => entry.node.label.text === 'РегламентированныйОтчетПрибыль');
    assert.ok(report);
    const templates = group(await explorer.getChildren(report), 'template');
    const [templateRows, templatesMs] = await timed(async () => {
      const rows = await explorer.getChildren(templates);
      rows.forEach(entry => explorer.getTreeItem(entry));
      await explorer.view.reveal(rows[rows.length - 1], { select: true, focus: false });
      return rows;
    });
    assert.equal(templateRows.length, 636);
    const warmRoot = [], selections = [], filters = [], source = [];
    for (let i = 0; i < 20; i++) {
      warmRoot.push((await timed(() => explorer.getChildren(root)))[1]);
      selections.push((await timed(() => explorer.view.reveal(moduleRows[i], { select: true, focus: false })))[1]);
      assert.equal(explorer.view.selection[0], moduleRows[i]);
    }
    for (let i = 0; i < 20; i++) {
      source.push((await timed(() => vscode.commands.executeCommand('eska.explorer.openSource', moduleRows[i])))[1]);
      assert.equal(vscode.window.activeTextEditor.document.uri.fsPath.endsWith('Module.bsl'), true);
    }
    for (let i = 0; i < 20; i++) {
      filters.push((await timed(async () => {
        await vscode.commands.executeCommand(`eska.explorer.${i % 2 ? 'hideEmptyGroups' : 'showEmptyGroups'}`, root);
        await explorer.getChildren(root);
      }))[1]);
    }
    const [, indexMs] = await timed(async () => {
      await vscode.commands.executeCommand('eska.explorer.search');
      explorer.searchView.picker.ignoreFocusOut = true;
      await until(() => explorer.searchView.session.snapshot.projects[0]?.progress?.state === 'ready', 'index complete');
    });
    const search = explorer.searchView;
    assert.equal(search.session.snapshot.projects[0].progress.failedDescriptors, 0);
    const searchMs = [], queryMs = [];
    for (let i = 0; i < 10; i++) for (const text of ['Контрагент', 'код', 'а', 'несуществующееимя987654321']) {
      searchMs.push((await timed(async () => {
        search.picker.value = text;
        await until(() => search.session.snapshot.text === text && !search.session.snapshot.loading, 'query complete');
      }))[1]);
      queryMs.push((await timed(() => explorer.tree.request(root.project, 'metadata/search', { text, limit: 50 })))[1]);
    }
    search.dispose();
    const [, refreshMs] = await timed(async () => {
      await vscode.commands.executeCommand('eska.explorer.refreshNode', report);
      await explorer.getChildren(report);
    });
    const [, fullRefreshMs] = await timed(() => explorer.tree.refresh(root.project));
    const [, reindexMs] = await timed(() => until(async () =>
      (await explorer.tree.request(root.project, 'metadata/index', { action: 'status' })).progress.state === 'ready', 'reindex complete'));
    const beforeIdle = await fs.readFile(`/proc/${pid}/status`, 'utf8');
    await new Promise(resolve => setTimeout(resolve, 500));
    const afterIdle = await fs.readFile(`/proc/${pid}/status`, 'utf8');
    const switches = text => Number(text.match(/^voluntary_ctxt_switches:\s+(\d+)/m)[1]);
    const idleWakeups = switches(afterIdle) - switches(beforeIdle);
    const backendMemory = await memory(pid), hostMemory = await memory(process.pid);
    await vscode.commands.executeCommand('eska.explorer.disconnect');
    await until(async () => { try { await fs.stat(`/proc/${pid}`); return false; } catch (error) { if (error.code === 'ENOENT') return true; throw error; } }, 'backend stopped', 10000);
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    rounds.push({ connect, rootMs, sectionsMs, modulesMs, templatesMs, warmRoot, selections, source, filters,
      indexMs, searchMs, queryMs, refreshMs, fullRefreshMs, reindexMs, idleWakeups, backendMemory, hostMemory, afterDisconnect: await memory(process.pid) });
  }
  const result = { passed: true, suite: 'performance', vscode: vscode.version, node: process.versions.node,
    diskCache: 'existing cache retained; fresh backend per round; OS cache not flushed', rounds };
  await fs.writeFile(path.join(fixture.root, 'host-result.json'), JSON.stringify(result));
  if (process.env.ESKA_PERF_RESULT) await fs.writeFile(process.env.ESKA_PERF_RESULT, JSON.stringify(result, null, 2));
};
