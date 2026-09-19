const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const vscode = require('vscode');

// Forced collection is confined to this test host; production never changes V8 flags.
require('node:v8').setFlagsFromString('--expose-gc');
const collect = require('node:vm').runInNewContext('gc');

/** Wait for state transitions without keeping old tree references in the caller. */
async function until(predicate, message) {
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.fail(message);
}

/** Let native refreshes and weak references settle before observing retained JavaScript memory. */
async function settle() {
  for (let i = 0; i < 3; i++) {
    await new Promise(resolve => setTimeout(resolve, 100));
    collect();
  }
}

/** Open thousands of real rows, optionally index, then relinquish all strong local references. */
async function cycle(explorer, index) {
  await vscode.commands.executeCommand('eska.explorer.connect');
  const pid = explorer.connection.child.pid;
  const tree = explorer.tree;
  const [root] = await explorer.getChildren();
  const common = (await explorer.getChildren(root)).find(row => row.node?.id.collection?.kind === 'common');
  const modules = (await explorer.getChildren(common)).find(row => row.node?.id.collection?.metadataKind === 'common-module');
  const rows = await explorer.getChildren(modules);
  assert.equal(rows.length, 3808);
  for (const row of rows) explorer.getTreeItem(row);
  await explorer.view.reveal(rows[rows.length - 1], { select: true, focus: false });
  if (index) {
    await tree.request(root.project, 'metadata/index', { action: 'start' });
    await until(async () => (await tree.request(root.project, 'metadata/index', { action: 'status' })).progress.state === 'ready', 'index complete');
    assert.ok((await tree.request(root.project, 'metadata/search', { text: 'Контрагент', limit: 50 })).hits.length);
  }
  const weak = Object.fromEntries(Object.entries({ tree, project: root.project, row: rows[0],
    backend: explorer.connection.child, files: explorer.files, watcher: explorer.watchers[0] })
    .map(([name, value]) => [name, new WeakRef(value)]));
  await vscode.commands.executeCommand('eska.explorer.disconnect');
  assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
  assert.equal(explorer.tree, undefined);
  assert.equal(explorer.decorations.entries.size, 0);
  return weak;
}

/** Separate retained extension objects from native editor RSS over twenty real reconnects. */
exports.run = async function () {
  assert.ok(process.env.ESKA_PERF_PROJECT);
  const fixture = JSON.parse(process.env.ESKA_HOST_FIXTURE);
  const explorer = await vscode.extensions.all.find(value => value.packageJSON.name === 'eska-explorer').activate();
  await vscode.commands.executeCommand('eska.explorer.disconnect');
  await vscode.commands.executeCommand('eska.explorer.projects.focus');
  await settle();
  const baseline = process.memoryUsage();
  const rounds = [];
  for (let round = 0; round < 20; round++) {
    const references = await cycle(explorer, round % 2 === 0);
    await settle();
    for (const [name, reference] of Object.entries(references)) {
      assert.equal(reference.deref(), undefined, `${name} retained after cycle ${round}`);
    }
    rounds.push({ round: round + 1, ...process.memoryUsage(), savedExpansionKeys: explorer.expanded.size });
  }
  const result = { passed: true, suite: 'memory', vscode: vscode.version, node: process.versions.node,
    method: '20 reconnects, 3808 rows per cycle, search index on 10 cycles; forced GC after disconnect', baseline, rounds };
  await fs.writeFile(path.join(fixture.root, 'host-result.json'), JSON.stringify(result));
  if (process.env.ESKA_MEMORY_RESULT) await fs.writeFile(process.env.ESKA_MEMORY_RESULT, JSON.stringify(result, null, 2));
};
