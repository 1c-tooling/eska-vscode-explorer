import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { BackendProcess } from "../out/process.js";
import { FrameReader, frame } from "../out/framing.js";
import { Connection } from "../out/connection.js";
import { API_VERSION, MAX_RESPONSE, parseWorkspace } from "../out/protocol.js";
import { assertHost } from "../out/host.js";
import { message } from "../out/messages.js";

const fixture = fileURLToPath(new URL("fake-backend.mjs", import.meta.url));
const hello = { apiVersion: API_VERSION, client: { name: "test", version: "0" }, locale: "ru-RU" };

/** All fake backends are owned by a test and reaped even on assertion failure. */
function child(t, mode = "ok", timeoutMs = 2000) {
  const value = new BackendProcess({ executable: process.execPath, args: [fixture, mode],
    cwd: process.cwd(), timeoutMs, log() {}, failed() {} });
  t.after(() => value.stop());
  return value;
}

/** Check actual process existence, not just the connection object's state. */
function exited(pid) {
  assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
}

test("framing accepts split UTF-8, combined frames and case-insensitive headers", () => {
  const first = Buffer.from('{"path":"Ёж/отчёт"}');
  const bytes = Buffer.concat([Buffer.from(`content-length: ${first.length}\r\nX-Future: yes\r\n\r\n`),
    first, frame({ second: true })]);
  for (const step of [1, 2, 17, bytes.length]) {
    const reader = new FrameReader();
    const values = [];
    for (let offset = 0; offset < bytes.length; offset += step) reader.push(bytes.subarray(offset, offset + step), (v) => values.push(v));
    reader.finish();
    assert.deepEqual(values, [{ path: "Ёж/отчёт" }, { second: true }]);
  }
});

test("framing rejects duplicate lengths, overflow, invalid UTF-8, BOM and truncation", () => {
  for (const bytes of [
    Buffer.from("Content-Length: 1\r\nContent-Length: 1\r\n\r\n0"),
    Buffer.from(`Content-Length: ${MAX_RESPONSE + 1}\r\n\r\n`),
    Buffer.from("Content-Length: -1\r\n\r\n"),
    Buffer.from("Content-Length: 0\r\n\r\n"),
    Buffer.from("x".repeat(8193)),
    Buffer.concat([Buffer.from("Content-Length: 1\r\n\r\n"), Buffer.from([255])]),
    Buffer.concat([Buffer.from("Content-Length: 5\r\n\r\n"), Buffer.from([239, 187, 191, 123, 125])]),
    Buffer.from("Content-Length: 3\r\n\r\n{}"),
  ]) {
    assert.throws(() => { const reader = new FrameReader(); reader.push(bytes, () => {}); reader.finish(); }, { code: "protocolInvalid" });
  }
});

test("handshake, Cyrillic paths and orderly shutdown use real process pipes", async (t) => {
  const peer = child(t);
  const result = await peer.request("initialize", hello);
  assert.equal(result.apiVersion.major, 1);
  const opened = parseWorkspace(await peer.request("workspace/open", { start: { value: "/проект", encoding: "utf-8" } }));
  assert.equal(opened.projects[0].generation, "9007199254740993");
  await peer.stop();
  exited(peer.pid);
  await peer.stop();
});

test("missing executable is reported and all pending requests are settled", async (t) => {
  const peer = new BackendProcess({ executable: "eska-nonexistent-test-binary", cwd: process.cwd(), log() {}, failed() {} });
  t.after(() => peer.stop());
  await assert.rejects(peer.request("initialize", hello), { code: "executableMissing" });
});

for (const [mode, code] of [["crash", "connectionLost"], ["garbage", "protocolInvalid"], ["hang", "timeout"]]) {
  test(`failed backend ${mode} settles pending requests and exits`, async (t) => {
    const peer = child(t, mode, mode === "hang" ? 150 : 2000);
    await assert.rejects(peer.request("initialize", hello), { code });
    await peer.stop();
    exited(peer.pid);
  });
}

test("backend ignoring shutdown is terminated within a deadline", async (t) => {
  const peer = child(t, "ignore-shutdown");
  await peer.request("initialize", hello);
  await peer.stop();
  exited(peer.pid);
});

/** Capture child instances so lifecycle tests can verify no orphan survives replacements. */
function connection(t, mode = "ok") {
  const children = [];
  const states = [];
  const starts = [];
  const versions = [];
  const value = new Connection("0", (state) => states.push(state), () => {}, (options) => {
    starts.push(options.args);
    const peer = new BackendProcess({ ...options, executable: process.execPath, args: [fixture, mode] });
    const request = peer.request.bind(peer);
    peer.request = (method, params, ...rest) => {
      if (method === "initialize") versions.push(params.apiVersion.minor);
      return request(method, params, ...rest);
    };
    children.push(peer);
    return peer;
  });
  t.after(() => value.dispose());
  return { value, children, states, starts, versions };
}

const target = { executable: process.execPath, path: process.cwd(), name: "test", locale: "ru-RU" };

/** A legacy peer is accepted only by the explicit legacy transport, with no automatic replacement. */
test("backend selection controls arguments, identity and API negotiation", async t => {
  const project = connection(t);
  await project.value.connect(target);
  assert.equal(project.value.state.kind, "ready");
  assert.deepEqual(project.starts, [["serve", "--stdio"]]);
  assert.equal(project.value.state.analyzerConfiguration, true);
  const legacy = connection(t, "legacy");
  await legacy.value.connect({ ...target, backend: "legacy" });
  assert.equal(legacy.value.state.kind, "ready");
  assert.deepEqual(legacy.starts, [["ide", "--stdio"]]);
  assert.equal(legacy.value.state.analyzerConfiguration, false);
  await legacy.value.connect({ ...target, backend: "project" });
  assert.equal(legacy.value.state.error.code, "legacyBackend");
  assert.equal(legacy.children.length, 2, "mismatch does not start a fallback process");
});

test("incompatible API is rejected before workspace/open", async (t) => {
  const { value, children } = connection(t, "incompatible");
  await value.connect(target);
  assert.equal(value.state.kind, "error");
  assert.equal(value.state.error.code, "incompatible");
  exited(children[0].pid);
});

/** Retry only an explicit compatible minor rejection, retaining the same process and project transport. */
test("API 1.12 keeps the tree without claiming query editing", async t => {
  const { value, children, starts } = connection(t, "api12");
  await value.connect(target);
  assert.equal(value.state.kind, "ready", JSON.stringify(value.state));
  assert.equal(value.state.analyzerConfiguration, true);
  assert.equal(value.state.queryEditing, undefined);
  assert.equal(children.length, 1);
  assert.deepEqual(starts, [["serve", "--stdio"]]);
});

/** Recovery absence is not a reason to disable an otherwise compatible project tree. */
test("API 1.13 is negotiated on the same process without claiming common recovery", async t => {
  const { value, children, starts } = connection(t, "api13");
  await value.connect(target);
  assert.equal(value.state.kind, "ready", JSON.stringify(value.state));
  assert.equal(value.recovery, undefined);
  assert.equal(children.length, 1);
  assert.deepEqual(starts, [["serve", "--stdio"]]);
});

// Older durable-storage backends keep their tree without admitting a memory-only source session.
for (const minor of [14, 15]) {
  test(`API 1.${minor} falls back to 1.14 on the same process`, async t => {
    const { value, children, versions } = connection(t, `api${minor}`);
    await value.connect(target);
    assert.equal(value.state.kind, "ready", JSON.stringify(value.state));
    assert.deepEqual(versions, [API_VERSION.minor, 14]);
    assert.equal(value.recovery?.sessions, undefined);
    assert.equal(children.length, 1);
  });
}

/** The durable XML lifecycle remains available without claiming the newer protected-source contract. */
test("API 1.16 is retained on the same process without claiming source snapshots", async t => {
  const { value, children, versions } = connection(t, "api16");
  await value.connect(target);
  assert.equal(value.state.kind, "ready", JSON.stringify(value.state));
  assert.deepEqual(versions, [API_VERSION.minor, 16]);
  assert.equal(value.sources, undefined);
  assert.equal(children.length, 1);
});

/** Existing project-bound source APIs remain usable when unclassified restoration is unavailable. */
test("API 1.17 fallback stays on the same process", async t => {
  const { value, children, versions } = connection(t, "api17");
  await value.connect(target);
  assert.equal(value.state.kind, "ready", JSON.stringify(value.state));
  assert.deepEqual(versions, [API_VERSION.minor, 17]);
  assert.equal(children.length, 1);
});

test("structured manifest error reaches UI category without server text", async (t) => {
  const { value } = connection(t, "missing-manifest");
  await value.connect(target);
  assert.equal(value.state.error.code, "manifestMissing");
  assert.match(message("ru", value.state.error.code), /eska init/);
  assert.match(message("en", value.state.error.code), /eska init/);
});

test("restart closes old backend before publishing a fresh session", async (t) => {
  const { value, children } = connection(t);
  await value.connect(target);
  assert.equal(value.state.kind, "ready");
  await value.connect({ ...target, name: "second" });
  exited(children[0].pid);
  assert.equal(value.state.target.name, "second");
  await value.disconnect();
  exited(children[1].pid);
  assert.equal(value.state.kind, "disconnected");
});

test("disconnect and rapid folder switching cannot publish stale open results", async (t) => {
  const { value, children, states } = connection(t, "slow");
  const first = value.connect(target);
  await new Promise((resolve) => setTimeout(resolve, 30));
  const second = value.connect({ ...target, name: "second" });
  const third = value.connect({ ...target, name: "third" });
  await Promise.all([first, second, third]);
  assert.equal(value.state.target.name, "third");
  assert.deepEqual(states.filter((s) => s.kind === "ready").map((s) => s.target.name), ["third"]);
  const restart = value.connect(target);
  await value.disconnect();
  await restart;
  assert.equal(value.state.kind, "disconnected");
  for (const peer of children) exited(peer.pid);
});

test("virtual and untrusted workspaces never become native paths", () => {
  assertHost(true, "file", undefined);
  assertHost(true, "vscode-remote", "ssh-remote");
  assert.throws(() => assertHost(false, "file", undefined), { code: "untrusted" });
  assert.throws(() => assertHost(true, "vscode-remote", undefined), { code: "unsupportedWorkspace" });
  assert.throws(() => assertHost(true, "github", "ssh-remote"), { code: "unsupportedWorkspace" });
});

test("a CLI exiting before initialize gives one actionable compatibility error", async (t) => {
  const { value, states } = connection(t, "crash");
  await value.connect(target);
  assert.equal(value.state.error.code, "handshakeFailed");
  assert.equal(states.filter((state) => state.kind === "error").length, 1);
});

test('cancelled requests are acknowledged without poisoning the next response', async t => {
  const peer = child(t);
  for (const method of ['test/cancellable', 'test/late']) {
    const controller = new AbortController();
    const pending = peer.request(method, {}, 2000, controller.signal);
    controller.abort();
    await assert.rejects(pending, { code: 'cancelled' });
    assert.equal((await peer.request('initialize', hello)).apiVersion.major, 1);
  }
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(peer.request('test/wait', {}, 2000, controller.signal), { code: 'cancelled' });
  await peer.stop();
  exited(peer.pid);
});

/** A cancelled UI read settles immediately, but its eventual response still belongs to the transport. */
test('cancellation does not wait for an uninterruptible read', async t => {
  const peer = child(t);
  await peer.request('initialize', hello);
  const controller = new AbortController();
  const pending = peer.request('test/late', {}, 2000, controller.signal);
  const started = performance.now();
  controller.abort();
  await assert.rejects(pending, { code: 'cancelled' });
  assert.ok(performance.now() - started < 150);
  await new Promise(resolve => setTimeout(resolve, 400));
  assert.equal((await peer.request('initialize', hello)).apiVersion.major, 1);
});

/** Probe disposal must reap a peer that ignores both protocol shutdown and SIGTERM. */
test('lifetime cancellation escalates to SIGKILL and reaps its process', async t => {
  const controller = new AbortController();
  const peer = new BackendProcess({ executable: process.execPath, args: [fixture, 'ignore-term'],
    cwd: process.cwd(), signal: controller.signal, log() {}, failed() {} });
  t.after(() => peer.stop());
  await peer.request('initialize', hello);
  controller.abort();
  await peer.stop();
  exited(peer.pid);
});

/** A published minor-30 server remains usable by the new constructor UI. */
test('API 1.30 falls back on the same process without new constructor features',async t=>{
 const {value,children,versions}=connection(t,'api30');await value.connect(target);
 assert.equal(value.state.kind,'ready',JSON.stringify(value.state));
 assert.deepEqual(versions,[API_VERSION.minor,30]);assert.equal(children.length,1);
 assert.equal(value.recovery?.sessions?.capabilities?.constructorLimits,undefined);
});
