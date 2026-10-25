const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const vscode = require('vscode');

/** Wait for actual support publication without scheduling additional policy requests. */
async function until(predicate, reason, timeout = 60000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error(reason);
}

/** Measure group expansion through the real tree provider with support enabled and source bytes preserved. */
exports.run = async function () {
  const fixture = JSON.parse(process.env.ESKA_HOST_FIXTURE);
  const root = process.env.ESKA_PERF_PROJECT;
  assert.ok(root, 'Set ESKA_PERF_PROJECT to a read-only large project.');
  const files = ['src/Configuration.xml', 'src/Ext/ParentConfigurations.bin', 'src/CommonModules/ОбщегоНазначения.xml'].map(file => path.join(root, file));
  /** Hash only the inputs used by this scenario; this is not a full source-tree checksum. */
  const hashes = () => Promise.all(files.map(async file => crypto.createHash('sha256').update(await fs.readFile(file)).digest('hex')));
  const before = await hashes();
  const explorer = await vscode.extensions.all.find(value => value.packageJSON.name === 'eska-explorer').activate();
  await until(() => explorer.tree && explorer.connection.state.kind === 'ready', 'backend ready');
  assert.equal(explorer.support.enabled, true);
  const rootEntry = (await explorer.getChildren()).find(entry => entry.node);
  const common = (await explorer.getChildren(rootEntry)).find(entry => entry.node?.id.collection?.kind === 'common');
  assert.ok(common);
  const group = (await explorer.getChildren(common)).find(entry => entry.node?.id.collection?.metadataKind === 'common-module');
  assert.ok(group);
  await explorer.support.serial;
  const methods = [], paints = new Set();
  const request = explorer.connection.request.bind(explorer.connection);
  explorer.connection.request = async (session, method, ...args) => {
    const started = performance.now();
    const result = await request(session, method, ...args);
    methods.push({ method, ms: performance.now() - started, items: args[0]?.objectIds?.length ?? args[0]?.paths?.length });
    return result;
  };
  const getTreeItem = explorer.getTreeItem.bind(explorer);
  explorer.getTreeItem = entry => {
    if (entry.node?.metadataKind === 'common-module') paints.add(entry.node.id.objectId);
    return getTreeItem(entry);
  };
  const started = performance.now();
  const entries = await explorer.getChildren(group);
  const childrenMs = performance.now() - started;
  assert.ok(entries.length > 1000);
  /** Read acknowledged state directly so polling cannot prime the queue under measurement. */
  const known = entry => {
    const snapshot = explorer.support.objectSnapshots?.get(entry.project) ?? explorer.support.snapshots.get(entry.project);
    const policy = snapshot?.objects.get(entry.node.id.objectId);
    return policy !== undefined && policy.state !== 'unknown';
  };
  const first = entries.slice(0, 32);
  let firstMs, allMs;
  try {
    await explorer.view.reveal(group, { expand: true, focus: false, select: false });
    await until(() => first.every(known), 'first visible policies published');
    firstMs = performance.now() - started;
    await until(() => entries.every(known), 'all expanded policies published');
    allMs = performance.now() - started;
    assert.deepEqual(await hashes(), before);
    const counts = Object.fromEntries([...new Set(methods.map(value => value.method))].map(method => [method, methods.filter(value => value.method === method).length]));
    const result = { passed: true, suite: 'support-navigation', vscode: vscode.version, locale: vscode.env.language,
      entries: entries.length, painted: paints.size, childrenMs, firstMs, allMs, counts, methods,
      filePolicies: explorer.support.fileIndex.size, inputHashes: before };
    await vscode.commands.executeCommand('eska.explorer.disconnect');
    await fs.writeFile(path.join(fixture.root, 'host-result.json'), JSON.stringify(result));
  } catch (error) {
    await fs.writeFile(path.join(fixture.root, 'host-result.json'), JSON.stringify({ passed: false, suite: 'support-navigation',
      error: String(error.stack ?? error), entries: entries.length, known: entries.filter(known).length, painted: paints.size,
      childrenMs, firstMs, allMs, methods }));
    throw error;
  }
};
