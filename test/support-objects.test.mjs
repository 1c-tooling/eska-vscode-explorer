import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SupportObjectQueue, objectPolicies } from '../out/support-objects.js';
import { ExplorerError } from '../out/protocol.js';

/** Let the queue perform real asynchronous batches without imposing a timing benchmark in unit tests. */
async function until(predicate) {
  const deadline = Date.now() + 5000;
  while (!predicate()) {
    assert.ok(Date.now() < deadline, 'queue made progress');
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}

/** A deferred response controls lifecycle boundaries while preserving the production queue. */
function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

/** Backend results must echo identities in order; unknown is a valid conservative display state. */
function response(ids, state = 'locked') {
  return { objects: ids.map(objectId => ({ objectId, uuid: objectId, state, reason: 'vendorLocked' })), diagnostics: [] };
}

test('painted objects are deduplicated, batched and published before later batches finish', async t => {
  const project = { info: { generation: '1', eventSequence: '0' } }, calls = [], published = [];
  const tree = { request: async (_project, method, { objectIds }) => {
    const gate = deferred(); calls.push({ method, ids: objectIds, gate });
    await gate.promise; return response(objectIds);
  } };
  const queue = new SupportObjectQueue((_project, snapshot) => published.push([...snapshot.objects.keys()]), assert.fail);
  t.after(() => queue.shutdown());
  for (let i = 0; i < 350; i++) { queue.enqueue(tree, project, String(i)); queue.enqueue(tree, project, String(i)); }
  await until(() => calls.length === 1);
  assert.equal(calls[0].ids.length, 128);
  assert.equal(calls[0].method, 'metadata/supportObjects');
  assert.deepEqual(published, []);
  calls[0].gate.resolve();
  await until(() => calls.length === 2);
  assert.equal(published[0].length, 128, 'first statuses are usable while the second batch is pending');
  calls[1].gate.resolve();
  await until(() => calls.length === 3);
  calls[2].gate.resolve();
  await until(() => published.length === 3);
  assert.deepEqual(calls.map(call => call.ids.length), [128, 128, 94]);
  assert.equal(new Set(published.flat()).size, 350);
});

test('policy invalidation and shutdown discard in-flight replies', async () => {
  const project = { info: { generation: '1', eventSequence: '0' } }, calls = [], published = [];
  const tree = { request: async (_project, _method, { objectIds }) => {
    const gate = deferred(); calls.push({ gate, ids: objectIds });
    await gate.promise; return response(objectIds);
  } };
  const queue = new SupportObjectQueue((_project, snapshot) => published.push([...snapshot.objects.keys()]), assert.fail);
  queue.enqueue(tree, project, 'old');
  await until(() => calls.length === 1);
  queue.invalidate(); project.info.generation = '2';
  queue.enqueue(tree, project, 'new'); calls[0].gate.resolve();
  await until(() => calls.length === 2);
  assert.deepEqual(published, []);
  calls[1].gate.resolve(); await until(() => published.length === 1);
  assert.deepEqual(published, [['new']]);
  queue.enqueue(tree, project, 'closing'); await until(() => calls.length === 3);
  const shutdown = queue.shutdown(); calls[2].gate.resolve(); await shutdown;
  assert.deepEqual(published, [['new']]);
});

test('malformed policy batches cannot partially publish or trigger an automatic retry loop', async () => {
  const ids = ['a', 'b'], valid = response(ids).objects;
  assert.deepEqual(objectPolicies(valid, ids), valid);
  for (const invalid of [valid.slice(0, 1), [...valid].reverse(), [{ ...valid[0], state: 'writable' }, valid[1]]]) {
    assert.throws(() => objectPolicies(invalid, ids), { code: 'protocolInvalid' });
  }
  const project = { info: { generation: '1', eventSequence: '0' } }, errors = [];
  let calls = 0;
  const tree = { request: async () => { calls++; return response(['wrong']); } };
  const queue = new SupportObjectQueue(assert.fail, error => errors.push(error));
  queue.enqueue(tree, project, 'a'); await until(() => errors.length === 1);
  queue.enqueue(tree, project, 'a'); await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(calls, 1);
  queue.invalidate(); queue.enqueue(tree, project, 'a'); await until(() => errors.length === 2);
  await queue.shutdown();
});

test('transient policy failures recover without repainting or reconnecting', async t => {
  const project = { info: { generation: '1', eventSequence: '0' } }, published = [];
  let calls = 0;
  const tree = { request: async (_project, _method, { objectIds }) => {
    if (++calls < 3) throw new ExplorerError('sourceChanged');
    return response(objectIds);
  } };
  const queue = new SupportObjectQueue((_project, snapshot) => published.push(snapshot), assert.fail);
  t.after(() => queue.shutdown());
  queue.enqueue(tree, project, 'a');
  await until(() => published.length === 1);
  assert.equal(calls, 3);
  assert.equal(published[0].objects.get('a').state, 'locked');
  queue.enqueue(tree, project, 'a');
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(calls, 3, 'successful objects remain deduplicated');
});

test('exhausted transient reads remain retryable and do not create an unbounded loop', async t => {
  const project = { info: { generation: '1', eventSequence: '0' } }, errors = [], published = [];
  let calls = 0, available = false;
  const tree = { request: async (_project, _method, { objectIds }) => {
    calls++;
    if (!available) throw new ExplorerError('timeout');
    return response(objectIds);
  } };
  const queue = new SupportObjectQueue((_project, snapshot) => published.push(snapshot), error => errors.push(error));
  t.after(() => queue.shutdown());
  queue.enqueue(tree, project, 'a');
  await until(() => errors.length === 1);
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(calls, 3);
  available = true; queue.enqueue(tree, project, 'a');
  await until(() => published.length === 1);
  assert.equal(calls, 4);
});

test('invalidation during retry backoff prevents an obsolete request from being sent again', async () => {
  const project = { info: { generation: '1', eventSequence: '0' } };
  let calls = 0;
  const tree = { request: async () => { calls++; throw new ExplorerError('sourceChanged'); } };
  const queue = new SupportObjectQueue(assert.fail, assert.fail);
  queue.enqueue(tree, project, 'a');
  await until(() => calls === 1);
  await queue.shutdown();
  assert.equal(calls, 1);
});
