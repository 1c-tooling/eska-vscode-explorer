import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { Connection } from '../out/connection.js';
import { MetadataTree } from '../out/tree.js';
import { SearchSession, parseSearch, parseProgress, revealHit } from '../out/search.js';
import { ExplorerError } from '../out/protocol.js';
import { createTreeProject } from './fixture.mjs';

/** Wait for a real asynchronous transition, with a diagnostic deadline. */
async function until(predicate, label) {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error(label);
}
const ready = { state: 'ready', indexedObjects: 3, pendingDescriptors: 0, failedDescriptors: 0 };
const rootId = { kind: 'object', objectId: 'root' };
/** Minimal valid wire hit for race and parser tests. */
function hit(name = 'Артикул') {
  const node = { kind: 'object', objectId: name };
  return { node, objectId: name, name, metadataKind: 'Attribute', synonyms: [], ancestry: [rootId, node], rank: 'exact_name' };
}

test('search wire validation rejects malformed progress, duplicate identities and foreign targets', () => {
  assert.throws(() => parseProgress({ ...ready, pendingDescriptors: -1 }), { code: 'protocolInvalid' });
  assert.throws(() => parseProgress({ ...ready, state: ['ready'] }), { code: 'protocolInvalid' });
  for (const hits of [[hit(), hit()], [{ ...hit(), node: rootId }], [{ ...hit(), ancestry: [] }], [{ ...hit(), rank: ['exact_name'] }]]) {
    assert.throws(() => parseSearch({ progress: ready, hits, truncated: false }, 50), { code: 'protocolInvalid' });
  }
});

test('typing is debounced, slow obsolete results are cancelled and cannot replace the current query', async t => {
  const calls = [];
  const project = { info: { projectId: 'p', generation: '0' } };
  let first;
  let notification;
  const tree = { session: { sessionId: 's' }, projects: [project],
    connection: { onNotification(listener) { notification = listener; return { dispose() {} }; } },
    async request(_project, method, params, signal) {
      calls.push({ method, params });
      if (method === 'metadata/index') return { progress: ready };
      if (params.text === 'old') return await new Promise(resolve => { first = { resolve, signal }; });
      return { progress: ready, hits: [hit(params.text)], truncated: false };
    } };
  const snapshots = [];
  const session = new SearchSession(tree, snapshot => snapshots.push(snapshot), 15, 15);
  t.after(() => session.dispose());
  session.setText('o'); session.setText('ol'); session.setText('old');
  await until(() => first, 'first query');
  assert.equal(calls.filter(call => call.method === 'metadata/search').length, 1);
  session.setText('НОВЫЙ');
  assert.equal(first.signal.aborted, true);
  assert.equal(session.snapshot.projects.length, 0, 'obsolete selectable hits cleared immediately');
  first.resolve({ progress: ready, hits: [hit('old')], truncated: false });
  await until(() => !session.snapshot.loading && session.snapshot.projects[0]?.hits[0]?.name === 'НОВЫЙ', 'new query');
  assert.ok(!snapshots.some(snapshot => snapshot.text === 'НОВЫЙ' && snapshot.projects.some(row => row.hits.some(hit => hit.name === 'old'))));
  const count = calls.length;
  notification('metadata/indexProgress', { sessionId: 'foreign', projectId: 'p', generation: '0' });
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(calls.length, count, 'foreign notifications do not trigger queries');
  session.dispose();
  notification('metadata/indexProgress', { sessionId: 's', projectId: 'p', generation: '0' });
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(calls.length, count);
});

const executable = process.env.ESKA_TEST_BINARY;
test('real search finds synonyms, duplicate nested names and unseen branches across four schemas', { skip: !executable }, async t => {
  const root = await mkdtemp(join(process.env.ESKA_TEST_ROOT ?? resolve('../eska-playground'), 'explorer-search-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const connection = new Connection('test', () => {}, () => {});
  t.after(() => connection.dispose());
  for (const type of ['configuration', 'extension', 'report', 'processing']) {
    const fixture = await createTreeProject(join(root, type), type);
    const original = await readFile(fixture.descriptor, 'utf8');
    const synonym = '<Synonym xmlns:v8="http://v8.1c.ru/8.1/data/core"><v8:item><v8:lang>ru</v8:lang><v8:content>Уникальный код товара</v8:content></v8:item></Synonym>';
    await writeFile(fixture.descriptor, original.replace('<Name>Артикул</Name>', '<Name>Артикул</Name>' + synonym));
    await connection.connect({ executable, path: fixture.root, name: type, locale: 'ru-RU' });
    assert.equal(connection.state.kind, 'ready');
    const tree = new MetadataTree(connection, connection.state.session, () => {}, () => {});
    const project = tree.projects[0];
    const session = new SearchSession(tree, () => {}, 5, 10);
    try {
      session.setText('уНиКаЛьНыЙ КОД');
      await until(() => !session.snapshot.loading && session.snapshot.projects[0]?.progress?.state === 'ready', `ready ${type}`);
      assert.equal(project.nodes.size, 0, 'index/search do not expand the client tree');
      const row = session.snapshot.projects[0];
      assert.equal(row.hits.length, 1);
      assert.equal(row.hits[0].name, 'Артикул');
      assert.equal(row.hits[0].rank, 'prefix_synonym');
      const entry = await revealHit(tree, project, row.hits[0]);
      assert.equal(entry.node.label.text, 'Артикул');
      const customers = [...project.nodes.values()].find(entry => entry.node.label.text === 'Покупатели');
      if (customers) assert.equal(customers.children, undefined, 'unrelated branch stays lazy');
      session.setText('Количество');
      await until(() => !session.snapshot.loading && session.snapshot.projects[0]?.hits.length, 'nested search');
      const nested = await revealHit(tree, project, session.snapshot.projects[0].hits[0]);
      assert.equal(nested.node.label.text, 'Количество');
      session.setText('Артикул');
      await until(() => !session.snapshot.loading && session.snapshot.projects[0]?.hits.length, 'duplicates');
      const duplicateHits = session.snapshot.projects[0].hits;
      assert.equal(duplicateHits.length, type === 'configuration' || type === 'extension' ? 2 : 1);
      const removed = duplicateHits.find(value => value.objectId === row.hits[0].objectId);
      await writeFile(fixture.descriptor, original.replace('<Name>Артикул</Name>', '<Name>НовыйАртикул</Name>'));
      await tree.refresh(project);
      await assert.rejects(revealHit(tree, project, removed), { code: 'sourceMissing' });
      session.setText('нетТакогоОбъекта');
      await until(() => !session.snapshot.loading && session.snapshot.projects[0]?.progress?.state === 'ready', 'empty query settled');
      assert.equal(session.snapshot.projects[0].hits.length, 0);
    } finally { session.dispose(); tree.dispose(); }
  }
});

test('real workspace search retains project identities, reports truncation and an incomplete index', { skip: !executable }, async t => {
  const root = await mkdtemp(join(process.env.ESKA_TEST_ROOT ?? resolve('../eska-playground'), 'explorer-search-workspace-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const first = await createTreeProject(join(root, 'first'));
  await createTreeProject(join(root, 'second'));
  for (const member of ['first', 'second']) await writeFile(join(root, member, 'eska.toml'), `[project]\nname='${member}'\ntype='configuration'\n`);
  await writeFile(join(root, 'eska.toml'), "[workspace]\nmembers=['first','second']\n");
  const xml = await readFile(first.descriptor, 'utf8');
  const many = Array.from({ length: 60 }, (_, i) => `<Attribute uuid="55555555-5555-5555-5555-${String(i).padStart(12, "0")}"><Properties><Name>Артикул${i}</Name></Properties></Attribute>`).join('');
  await writeFile(first.descriptor, xml.replace('<ChildObjects>', '<ChildObjects>' + many));
  await writeFile(join(first.source, 'Catalogs', 'Покупатели.xml'), '<broken');
  const connection = new Connection('test', () => {}, () => {});
  t.after(() => connection.dispose());
  await connection.connect({ executable, path: root, name: 'workspace', locale: 'en-US' });
  assert.equal(connection.state.kind, 'ready', JSON.stringify(connection.state));
  const tree = new MetadataTree(connection, connection.state.session, () => {}, () => {});
  t.after(() => tree.dispose());
  const session = new SearchSession(tree, () => {}, 5, 10);
  t.after(() => session.dispose());
  session.setText('Артикул');
  await until(() => !session.snapshot.loading && session.snapshot.projects.length === 2
    && session.snapshot.projects.every(row => ['ready', 'incomplete'].includes(row.progress?.state)), 'workspace completion');
  const rows = session.snapshot.projects;
  const limited = rows.find(row => row.project.info.scope.name === 'first');
  assert.equal(limited.progress.state, 'incomplete');
  assert.equal(limited.progress.failedDescriptors, 1);
  assert.equal(limited.hits.length, 50);
  assert.equal(limited.truncated, true);
  const sharedId = limited.hits.find(hit => hit.name === 'Артикул').objectId;
  const same = rows.map(row => row.hits.find(hit => hit.objectId === sharedId));
  assert.equal(same[0].objectId, same[1].objectId, 'same logical ID can belong to independent projects');
  assert.notEqual(rows[0].project.key, rows[1].project.key);
  for (let i = 0; i < rows.length; i++) assert.equal((await revealHit(tree, rows[i].project, same[i])).project, rows[i].project);
});

test('progress bursts update partial results once and isolate errors in other projects', async t => {
  const projects = ['good', 'bad'].map(projectId => ({ info: { projectId, generation: '1' } }));
  let notify;
  let state = 'not_started';
  let starts = 0;
  let searches = 0;
  const progress = () => ({ ...ready, state, pendingDescriptors: state === 'ready' ? 0 : 10 });
  const tree = { session: { sessionId: 's' }, projects,
    connection: { onNotification(listener) { notify = listener; return { dispose() {} }; } },
    async request(project, method, params) {
      if (project === projects[1]) throw new ExplorerError('branchInvalid');
      if (method === 'metadata/index') {
        if (params.action === 'start') { starts++; state = 'building'; }
        return { progress: progress() };
      }
      searches++;
      assert.equal(params.limit, 50);
      return { progress: progress(), hits: [hit()], truncated: false };
    } };
  const session = new SearchSession(tree, () => {}, 5, 15);
  t.after(() => session.dispose());
  session.setText('Артикул');
  await until(() => !session.snapshot.loading, 'partial response');
  assert.equal(session.snapshot.projects[0].progress.state, 'building');
  assert.equal(session.snapshot.projects[0].hits.length, 1);
  assert.equal(session.snapshot.projects[1].error.code, 'branchInvalid');
  state = 'ready';
  for (let i = 0; i < 100; i++) notify('metadata/indexProgress', { sessionId: 's', projectId: 'good', generation: '1' });
  await until(() => session.snapshot.projects[0]?.progress?.state === 'ready', 'ready notification');
  assert.equal(starts, 1, 'query/progress never rebuild an existing index');
  assert.equal(searches, 2, 'one coalesced update for the notification burst');
});
