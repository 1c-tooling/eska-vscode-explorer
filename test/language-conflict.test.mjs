import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { runInNewContext } from "node:vm";

const ID = "elishevkirill.bsl-analyzer-lsp";

/** Hold exactly one asynchronous boundary while a real controller generation changes. */
function barrier() { let release; const promise = new Promise(done => { release = done; }); return { promise, release }; }

/** Only protocol/UI/process boundaries are mocked; production LanguageService owns all conflict and lease decisions. */
function fixture({ available = false, enabled = true, hold } = {}) {
  const root = resolve(process.env.ESKA_TEST_ROOT ?? "../eska-playground", "conflict-dto"), wire = value => ({ value, encoding: "utf-8" });
  const calls = [], warnings = [], commands = [], owners = [], clients = [], listeners = new Set(), documents = new Set();
  let conflict = available, feature = enabled, reached, held = false, leased = false;
  const waiting = barrier(), pause = barrier();
  const checkpoint = async name => { calls.push(name); if (hold === name && !held) { held = true; reached = name; waiting.release(); await pause.promise; } };
  const ready = { kind: "ready", analyzerConfiguration: true, target: { path: root, backend: "project" } };
  const dto = { schema_version: 1, kind: "analyzer-configuration", status: "current", path: wire(join(root, "bsl-analyzer.toml")),
    preview_token: "a".repeat(64), ownership: { schema_version: 1, generator_version: 1, analyzer_version: "0.3.2", context: null,
      input_fingerprint: "b".repeat(64), body_sha256: "c".repeat(64) } };
  const connection = { state: ready, onNotification() { return { dispose() {} }; }, async analyzerRequest(method, _params, signal) {
    if (method === "analyzer/acquire") { assert.equal(signal, undefined); leased = true; }
    if (method === "analyzer/release") leased = false;
    await checkpoint(method);
    if (method === "analyzer/context") return { schema_version: 1, kind: "project-context", status: "ready", context: {
      root: wire(root), name: null, limited_context: false, sources: [{ root: wire(root), source: wire(join(root, "src")), member: null, role: "configuration", project_type: "configuration" }] } };
    return method === "analyzer/acquire" ? { ...dto, leaseId: "d".repeat(64) } : dto;
  } };
  const tooling = { states: { analyzer: { phase: "missing" } }, analyzerState(phase, detail) { this.states.analyzer.phase = phase; this.states.analyzer.detail = detail; },
    async ensureAnalyzer(_signal, offer) { await checkpoint(offer ? "ensureAnalyzer" : "inspect-only"); return { path: join(root, "analyzer"), version: "0.3.2" }; } };
  const vscode = {
    env: { language: "en-US" },
    workspace: { isTrusted: true, textDocuments: [{ languageId: "bsl" }], getConfiguration() { return { get() { return feature; } }; },
      onDidOpenTextDocument(callback) { documents.add(callback); return { dispose() { documents.delete(callback); } }; } },
    extensions: { getExtension(id) { assert.equal(id, ID); return conflict ? { id, isActive: false, activate() { assert.fail("foreign activation"); } } : undefined; },
      onDidChange(callback) { listeners.add(callback); return { dispose() { listeners.delete(callback); } }; } },
    window: { showWarningMessage(text, ...actions) { const answer = barrier(); warnings.push({ text, actions, answer }); return answer.promise; },
      async showErrorMessage(text) { calls.push(`error:${text}`); } },
    commands: { async executeCommand(...args) { commands.push(args); } }, Uri: { file: value => value },
  };
  class FakeClient {
    constructor(_id, _name, start) { this.startServer = start; this.protocol2CodeConverter = {}; clients.push(this); }
    async start() { await this.startServer(); await checkpoint("client.start"); this.initializeResult = { serverInfo: { name: "bsl-analyzer", version: "0.3.2" }, capabilities: {} }; }
    async stop() { this.stopped = true; } async dispose() { this.disposed = true; }
  }
  class FakeOwner { constructor() { this.child = { pid: 100 + owners.length, stdout: {}, stdin: {} }; owners.push(this); } async stop() { this.stopped = true; } }
  const adapter = { exports: {} }, require = createRequire(new URL("../out/language/service.js", import.meta.url));
  runInNewContext(`(function(require,module,exports){${readFileSync(new URL("../out/language/service.js", import.meta.url), "utf8")}\n})`, { AbortController, AbortSignal, process })(
    name => name === "vscode" ? vscode : name === "vscode-languageclient/node" ? { LanguageClient: FakeClient, CloseAction: {}, ErrorAction: {} }
      : name === "./process.js" ? { LanguageProcess: FakeOwner } : require(name), adapter, adapter.exports);
  const context = { workspaceState: { get() {}, async update() { await checkpoint("selection.update"); } } };
  const service = new adapter.exports.LanguageService(context, connection, tooling, {}, () => {});
  return { service, tooling, calls, warnings, commands, owners, clients, pause, waiting, get reached() { return reached; }, get leased() { return leased; },
    connect() { service.connectionChanged(ready); }, setAvailable(value, notify = true) { conflict = value; if (notify) for (const listener of listeners) listener(); },
    setEnabled(value) { feature = value; }, listeners, documents };
}

/** Follow any queued generation created by the controller itself, without fixed sleeps. */
async function settled(service) { let pending; do { pending = service.queue; await pending; } while (pending !== service.queue); }

test("an enabled inactive extension blocks preparation and repeated restarts warn once per conflict episode", async t => {
  const f = fixture({ available: true }); t.after(() => f.service.shutdown()); f.connect(); await settled(f.service);
  for (let i = 0; i < 4; i++) await f.service.restart();
  assert.equal(f.warnings.length, 1); assert.equal(f.owners.length, 0);
  assert.ok(!f.calls.includes("analyzer/context")); assert.ok(f.calls.includes("inspect-only"));
  assert.equal(f.tooling.states.analyzer.phase, "suspended-conflict");
  f.warnings[0].answer.release(f.warnings[0].actions[0]); await new Promise(resolve => setTimeout(resolve, 0));
  assert.deepEqual(f.commands, [["workbench.extensions.search", `@id:${ID}`]]);
  f.setAvailable(false); await settled(f.service); assert.equal(f.tooling.states.analyzer.phase, "ready"); assert.equal(f.owners.length, 1);
  f.setAvailable(true); await settled(f.service); assert.equal(f.warnings.length, 2); assert.equal(f.owners[0].stopped, true); assert.equal(f.leased, false);
});

for (const hold of ["analyzer/context", "ensureAnalyzer", "analyzer/configStatus", "analyzer/configPrepare", "analyzer/acquire", "client.start", "selection.update"]) {
  test(`a conflict during ${hold} invalidates the old generation, reaps its peer and releases a handed-off lease`, async t => {
    const f = fixture({ hold }); t.after(() => f.service.shutdown()); f.connect(); await f.waiting.promise;
    assert.equal(f.reached, hold); f.setAvailable(true); f.pause.release(); await settled(f.service);
    assert.equal(f.tooling.states.analyzer.phase, "suspended-conflict"); assert.equal(f.service.session, undefined);
    assert.equal(f.leased, false); assert.ok(f.owners.every(owner => owner.stopped)); assert.equal(f.warnings.length, 1);
    f.setAvailable(false); await settled(f.service); assert.equal(f.tooling.states.analyzer.phase, "ready");
    assert.equal(f.leased, true); assert.ok(f.service.session);
  });
}

test("guard checks availability after awaits even before an extension-change event is delivered", async t => {
  const f = fixture({ hold: "analyzer/configPrepare" }); t.after(() => f.service.shutdown());
  f.connect(); await f.waiting.promise; f.setAvailable(true, false); f.pause.release(); await settled(f.service);
  assert.equal(f.tooling.states.analyzer.phase, "suspended-conflict"); assert.ok(!f.calls.includes("analyzer/acquire"));
  assert.equal(f.owners.length, 0); assert.equal(f.warnings.length, 1);
});

test("a resolved conflict cannot apply a late management choice or override a disabled client", async t => {
  const f = fixture({ available: true }); t.after(() => f.service.shutdown()); f.connect(); await settled(f.service);
  f.setEnabled(false); f.setAvailable(false); await settled(f.service);
  f.warnings[0].answer.release(f.warnings[0].actions[0]); await new Promise(resolve => setTimeout(resolve, 0));
  assert.deepEqual(f.commands, []); assert.equal(f.owners.length, 0); assert.equal(f.tooling.states.analyzer.phase, "suspended");
  await f.service.shutdown(); assert.equal(f.listeners.size, 0); assert.equal(f.documents.size, 0);
});
