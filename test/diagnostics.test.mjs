import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { BackendProcess } from "../out/process.js";
import { requestContext } from "../out/diagnostics.js";

const fixture = fileURLToPath(new URL("fake-backend.mjs", import.meta.url));
/** Capture actual transport diagnostics without depending on VS Code's log channel implementation. */
function recordingPeer(t, timeoutMs = 1000) {
  const events = [];
  const peer = new BackendProcess({ executable: process.execPath, args: [fixture], cwd: process.cwd(), timeoutMs,
    log: line => events.push(JSON.parse(line)), failed() {} });
  t.after(() => peer.stop());
  return { peer, events };
}

test("timeout identifies the request, queue, process and client-initiated termination", async t => {
  const { peer, events } = recordingPeer(t, 150);
  await assert.rejects(peer.request('test/wait', { sessionId: 's', projectId: 'p', generation: '10',
    node: { kind: 'object', objectId: 'catalog:Товары' }, xml: 'PRIVATE_XML_CONTENT' }), { code: 'timeout' });
  await peer.stop();
  const timeout = events.find(event => event.event === 'request_timeout');
  assert.equal(timeout.method, 'test/wait');
  assert.equal(timeout.node.objectId, 'catalog:Товары');
  assert.equal(timeout.projectId, 'p');
  assert.ok(timeout.elapsedMs >= 100);
  assert.equal(timeout.pid, peer.pid);
  assert.ok(events.some(event => event.event === 'process_signal' && event.reason === 'timeout'));
  assert.ok(events.find(event => event.event === 'connection_failure').pending.some(request => request.method === 'test/wait'));
  assert.ok(!JSON.stringify(events).includes('PRIVATE_XML_CONTENT'));
});

test("late stderr survives the live cap and a crash retains its exit code", async t => {
  const { peer, events } = recordingPeer(t);
  await assert.rejects(peer.request('test/noisy-crash', {}), { code: 'connectionLost' });
  await peer.stop();
  assert.equal(events.find(event => event.event === 'process_closed').exitCode, 17);
  assert.match(events.find(event => event.event === 'stderr_tail').text, /LATE_PANIC_REASON/);
  assert.ok(JSON.stringify(events).length < 40000, 'stderr storage/output remains bounded');
});

test("structured errors retain operation, source path and reason without copying response bodies", async t => {
  const { peer, events } = recordingPeer(t);
  await assert.rejects(peer.request('test/error', {}), { code: 'branchInvalid' });
  const failure = events.find(event => event.event === 'request_error');
  assert.equal(failure.kind, 'xml_invalid');
  assert.equal(failure.method, 'test/error');
  assert.equal(failure.details.reason, 'malformed');
  assert.equal(failure.details.path.value, 'Catalogs/Товары.xml');
  assert.ok(!JSON.stringify(events).includes('PRIVATE_RESPONSE_BODY'));
});

test("truncated response records its expected and received lengths", async t => {
  const { peer, events } = recordingPeer(t);
  await assert.rejects(peer.request('test/truncated', {}), { code: 'protocolInvalid' });
  await peer.stop();
  const failure = events.find(event => event.event === 'stdout_truncated');
  assert.deepEqual(failure.frame, { phase: 'body', receivedBytes: 2, expectedBytes: 100 });
});

test("file event samples and identities have fixed diagnostic bounds", () => {
  const context = requestContext({ paths: Array.from({ length: 4096 }, () => ({ value: 'x'.repeat(2000), encoding: 'utf-8' })) });
  assert.equal(context.pathCount, 4096);
  assert.equal(context.pathSample.length, 5);
  assert.equal(context.pathSample[0].value.length, 513);
});

test("orderly shutdown is not reported as a connection failure", async t => {
  const { peer, events } = recordingPeer(t);
  await peer.stop('disconnect');
  assert.equal(events.find(event => event.event === 'process_closed').exitCode, 0);
  assert.ok(!events.some(event => event.event === 'connection_failure'));
});
