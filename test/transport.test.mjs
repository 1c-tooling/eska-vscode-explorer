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
    const peer = child(t, mode, 150);
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
  const value = new Connection("0", (state) => states.push(state), () => {}, (options) => {
    const peer = new BackendProcess({ ...options, executable: process.execPath, args: [fixture, mode] });
    children.push(peer);
    return peer;
  });
  t.after(() => value.dispose());
  return { value, children, states };
}

const target = { executable: process.execPath, path: process.cwd(), name: "test", locale: "ru-RU" };

test("incompatible API is rejected before workspace/open", async (t) => {
  const { value, children } = connection(t, "incompatible");
  await value.connect(target);
  assert.equal(value.state.kind, "error");
  assert.equal(value.state.error.code, "incompatible");
  exited(children[0].pid);
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
