import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { runInNewContext } from "node:vm";
import { LSPErrorCodes, ResponseError } from "vscode-languageserver-protocol/node";

const ID = "elishevkirill.bsl-analyzer-lsp";

/** Hold exactly one asynchronous boundary while a real controller generation changes. */
function barrier() { let release; const promise = new Promise(done => { release = done; }); return { promise, release }; }

/** Only protocol/UI/process boundaries are mocked; production LanguageService owns all conflict and lease decisions. */
function fixture({ available = false, enabled = true, hold, outside = false, status, changedLease = false } = {}) {
  const root = resolve(process.env.ESKA_TEST_ROOT ?? "../eska-playground", "conflict-dto"), wire = value => ({ value, encoding: "utf-8" });
  const calls = [], warnings = [], commands = [], owners = [], clients = [], watchers = [], listeners = new Set(), documents = new Set(), notifications = new Set();
  let conflict = available, feature = enabled, reached, held = false, leased = false, changed;
  const waiting = barrier(), pause = barrier();
  const checkpoint = async name => { calls.push(name); if (hold === name && !held) { held = true; reached = name; waiting.release(); await pause.promise; } };
  const ready = { kind: "ready", analyzerConfiguration: true, target: { path: root, backend: "project" },
    session: { sessionId: "session", projects: [{ projectId: "project", rootPath: wire(root), sourcePath: wire(join(root, "src")) }] } };
  const sourceRoot = outside ? join(root, "other") : root;
  const dto = { schema_version: 1, kind: "analyzer-configuration", status: status ?? (hold === "analyzer/configPrepare" ? "missing" : "current"), path: wire(join(root, "bsl-analyzer.toml")),
    preview_token: "a".repeat(64), ownership: { schema_version: 1, generator_version: 1, analyzer_version: "0.3.2", context: outside ? "two" : null,
      input_fingerprint: "b".repeat(64), body_sha256: "c".repeat(64) } };
  const connection = { state: ready, onNotification(listener) { notifications.add(listener); return { dispose() { notifications.delete(listener); } }; }, async analyzerRequest(method, _params, signal) {
    if (method === "analyzer/acquire") { assert.equal(signal, undefined); leased = true; }
    if (method === "analyzer/release") leased = false;
    await checkpoint(method);
    if (method === "analyzer/configPrepare") dto.status = "current";
    if (method === "analyzer/context") return { schema_version: 1, kind: "project-context", status: "ready", context: {
      root: wire(root), name: outside ? "two" : null, limited_context: false, sources: [{ root: wire(sourceRoot), source: wire(join(sourceRoot, "src")), descriptor: wire("Configuration.xml"), member: outside ? "other" : null, role: "configuration", project_type: "configuration" }] } };
    return method === "analyzer/acquire" ? { ...dto, leaseId: "d".repeat(64), ...(changedLease ? { preview_token: "e".repeat(64) } : {}) } : dto;
  } };
  const tooling = { states: { analyzer: { phase: "missing" } }, analyzerState(phase, detail) { this.states.analyzer.phase = phase; this.states.analyzer.detail = detail; },
    async ensureAnalyzer(_signal, offer) { await checkpoint(offer ? "ensureAnalyzer" : "inspect-only"); return { path: join(root, "analyzer"), version: "0.3.2" }; } };
  const vscode = {
    env: { language: "en-US" }, CancellationError: class extends Error {}, RelativePattern: class {},
    CancellationTokenSource: class {
      controller = new AbortController();
      /** Model the public editor cancellation boundary, including listener disposal. */
      get token() {
        const signal = this.controller.signal;
        return { get isCancellationRequested() { return signal.aborted; },
          onCancellationRequested(listener) { signal.addEventListener("abort", listener); return { dispose() { signal.removeEventListener("abort", listener); } }; } };
      }
      /** Cancellation is synchronous even while the upstream reply is held. */
      cancel() { this.controller.abort(); }
      /** No native resource belongs to this test token. */
      dispose() {}
    },
    workspace: { isTrusted: true, textDocuments: [{ languageId: "bsl", uri: { toString: () => "file:///same.bsl" }, version: 1, isClosed: false }], getConfiguration() { return { get() { return feature; } }; },
      onDidOpenTextDocument(callback) { documents.add(callback); return { dispose() { documents.delete(callback); } }; },
      onDidChangeTextDocument(callback) { changed = callback; return { dispose() { changed = undefined; } }; },
      createFileSystemWatcher() { const callbacks = new Set(), watcher = {
        onDidCreate(callback) { callbacks.add(callback); }, onDidChange(callback) { callbacks.add(callback); }, onDidDelete(callback) { callbacks.add(callback); },
        /** Native watcher callbacks always receive a URI and can also see virtual schemes. */
        fire(uri = {}) { for (const callback of callbacks) callback({ scheme: "file", ...uri }); },
        dispose() { callbacks.clear(); this.disposed = true; } };
        watchers.push(watcher); return watcher;
      } },
    extensions: { getExtension(id) { assert.equal(id, ID); return conflict ? { id, isActive: false, activate() { assert.fail("foreign activation"); } } : undefined; },
      onDidChange(callback) { listeners.add(callback); return { dispose() { listeners.delete(callback); } }; } },
    window: { showWarningMessage(text, ...actions) { const answer = barrier(); warnings.push({ text, actions, answer }); return answer.promise; },
      async showErrorMessage(text) { calls.push(`error:${text}`); } },
    commands: { async executeCommand(...args) { commands.push(args); } }, Uri: { file: value => value },
  };
  class FakeClient {
    constructor(_id, _name, start, options) { this.startServer = start; this.clientOptions = options; this.protocol2CodeConverter = {};
      const diagnostics = new Map();
      this.diagnostics = { clear() { calls.push("diagnostics.clear"); diagnostics.clear(); }, delete(uri) { diagnostics.delete(uri.toString()); },
        set(uri, values) { diagnostics.set(uri.toString(), { uri, values }); }, get(uri) { return diagnostics.get(uri.toString())?.values; },
        forEach(callback) { for (const { uri, values } of diagnostics.values()) callback(uri, values); } }; clients.push(this); }
    async start() { await this.startServer(); await checkpoint("client.start"); this.initializeResult = { serverInfo: { name: "bsl-analyzer", version: "0.3.2" }, capabilities: {} }; }
    async stop() { this.stopped = true; } async dispose() { this.disposed = true; }
  }
  class FakeOwner { constructor() { this.child = { pid: 100 + owners.length, stdout: {}, stdin: {} }; owners.push(this); } async stop() { this.stopped = true; } }
  const adapter = { exports: {} }, require = createRequire(new URL("../out/language/service.js", import.meta.url));
  const watching = { exports: {} }, watchRequire = createRequire(new URL("../out/watch.js", import.meta.url));
  runInNewContext(`(function(require,module,exports){${readFileSync(new URL("../out/watch.js", import.meta.url), "utf8")}\n})`, { process, setTimeout, clearTimeout })(
    name => name === "vscode" ? vscode : watchRequire(name), watching, watching.exports);
  runInNewContext(`(function(require,module,exports){${readFileSync(new URL("../out/language/service.js", import.meta.url), "utf8")}\n})`, { AbortController, AbortSignal, process, setTimeout, clearTimeout })(
    name => name === "vscode" ? vscode : name === "vscode-languageclient/node" ? { LanguageClient: FakeClient, CloseAction: {}, ErrorAction: {}, LSPErrorCodes, ResponseError }
      : name === "./process.js" ? { LanguageProcess: FakeOwner }
        : name === "./edits.js" ? { LanguageEdits: class { middleware() { return {}; } async shutdown() {} } }
          : name === "../watch.js" ? watching.exports : require(name), adapter, adapter.exports);
  const context = { workspaceState: { get() {}, async update() { await checkpoint("selection.update"); } } };
  const policyRoots = [];
  const service = new adapter.exports.LanguageService(context, connection, tooling, {}, () => {}, undefined, roots => policyRoots.push([...roots]));
  return { root, sourceRoot, service, tooling, calls, warnings, commands, owners, clients, watchers, policyRoots, dto, pause, waiting, get reached() { return reached; }, get leased() { return leased; },
    /** Give independent callers genuine cancellable subscriptions in the fake editor. */
    cancellation() { return new vscode.CancellationTokenSource(); },
    /** Exercise the actual metadata subscription without a second project parser. */
    metadata(params = {}) { for (const listener of notifications) listener("metadata/changed", { sessionId: "session", projectId: "project", ...params }); },
    /** Pause a later request after initial startup has completed. */
    holdAt(name) { hold = name; held = false; },
    /** Model the editor changing an open buffer while a config check is pending. */
    advanceDocument() { vscode.workspace.textDocuments[0].version++; },
    /** Reopening the same URI creates a new document lifetime even if its version restarts at one. */
    reopenDocument() {
      const document = vscode.workspace.textDocuments[0]; document.isClosed = true;
      vscode.workspace.textDocuments[0] = { ...document, version: 1, isClosed: false };
    },
    /** Deliver a real content change, keeping the mock document inside the selected context. */
    changeDocument() {
      const document = vscode.workspace.textDocuments[0];
      document.uri = { scheme: "file", fsPath: join(root, "src", "Module.bsl"), toString: () => "file:///same.bsl" };
      document.version++;
      changed({ document, contentChanges: [{ text: "edited" }] });
    },
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

/** Wait only for the controller's observable debounce/check/queue to drain. */
async function configurationSettled(service) {
  const deadline = Date.now() + 5000;
  while (service.configurationTimer || service.configurationCheck || service.checkRequested) {
    assert.ok(Date.now() < deadline, "configuration check did not settle");
    await new Promise(done => setTimeout(done, 10));
  }
  await settled(service);
}

test("an XML burst rechecks one context without a new index and cancels replies from the older model", async t => {
  const f = fixture(); t.after(() => f.service.shutdown()); f.connect(); await settled(f.service);
  const client = f.clients[0], held = barrier();
  const reply = client.clientOptions.middleware.sendRequest("workspace/symbol", {}, undefined, () => held.promise);
  for (let i = 0; i < 40; i++) f.service.sourceChanged(join(f.root, "src", "Catalogs", "Товары.xml"));
  held.release("old model"); await assert.rejects(reply);
  await configurationSettled(f.service);
  assert.equal(f.owners.length, 1); assert.equal(f.owners[0].stopped, undefined);
  assert.equal(f.calls.filter(value => value === "analyzer/configStatus").length, 2);
  assert.equal(f.calls.filter(value => value === "analyzer/configPrepare").length, 0);
});

for (const status of ["current", "missing", "stale"]) {
  test(`startup preserves validation and leases for a ${status} configuration`, async t => {
    const f = fixture({ status }); t.after(() => f.service.shutdown()); f.connect(); await settled(f.service);
    assert.equal(f.tooling.states.analyzer.phase, "ready");
    assert.equal(f.calls.filter(value => value === "ensureAnalyzer").length, 1, "the binary is always checked");
    assert.equal(f.calls.filter(value => value === "analyzer/configPrepare").length, status === "current" ? 0 : 1);
    assert.equal(f.calls.filter(value => value === "analyzer/acquire").length, 1);
    assert.equal(f.leased, true);
  });
}

test("a current config changed before lease acquisition cannot launch an unchecked server", async t => {
  const f = fixture({ changedLease: true }); t.after(() => f.service.shutdown()); f.connect(); await settled(f.service);
  assert.equal(f.tooling.states.analyzer.phase, "error");
  assert.equal(f.owners.length, 0);
  assert.equal(f.leased, false);
  assert.equal(f.calls.filter(value => value === "analyzer/release").length, 1);
});

test("buffer edits reject old reads without publishing an artificial empty diagnostic collection", async t => {
  const f = fixture(); t.after(() => f.service.shutdown()); f.connect(); await settled(f.service);
  const client = f.clients[0], held = barrier(), uri = { toString: () => "file:///same.bsl" };
  const middleware = client.clientOptions.middleware;
  middleware.handleDiagnostics(uri, ["original"], (uri, values) => client.diagnostics.set(uri, values));
  let requestToken;
  const started = barrier();
  const reply = middleware.sendRequest("textDocument/definition", { textDocument: { uri: uri.toString() } }, undefined,
    (_type, _params, token) => { requestToken = token; started.release(); return held.promise; });
  await started.promise;
  assert.equal(requestToken.isCancellationRequested, false);
  f.changeDocument();
  assert.equal(requestToken.isCancellationRequested, true, "obsolete work is cancelled before the upstream response");
  held.release("old definition");
  await assert.rejects(reply, error => error.code === LSPErrorCodes.RequestCancelled);
  assert.deepEqual(client.diagnostics.get(uri), ["original"]);
  middleware.handleDiagnostics(uri, ["fresh"], (uri, values) => client.diagnostics.set(uri, values));
  assert.deepEqual(client.diagnostics.get(uri), ["fresh"]);
  f.service.manifestChanged();
  assert.equal(client.diagnostics.get(uri), undefined, "changing context must still clear previous diagnostics");
});

test("identical concurrent symbols share one upstream snapshot and receive independent response objects", async t => {
  const f = fixture(); t.after(() => f.service.shutdown()); f.connect(); await settled(f.service);
  const middleware = f.clients[0].clientOptions.middleware, held = barrier(), entered = barrier();
  const params = { textDocument: { uri: "file:///same.bsl" } }; let calls = 0;
  /** One real request remains pending while a second editor consumer asks for the same snapshot. */
  const next = () => { calls++; entered.release(); return held.promise; };
  const one = middleware.sendRequest("textDocument/documentSymbol", params, undefined, next);
  const two = middleware.sendRequest("textDocument/documentSymbol", params, undefined, next);
  await entered.promise; assert.equal(calls, 1);
  held.release([{ name: "symbol", children: [] }]);
  const [first, second] = await Promise.all([one, two]);
  assert.deepEqual(first, second); assert.notEqual(first, second);
  first[0].name = "changed by a converter"; assert.equal(second[0].name, "symbol");
  assert.deepEqual(await middleware.sendRequest("textDocument/documentSymbol", params, undefined, async () => { calls++; return ["fresh"]; }), ["fresh"]);
  assert.equal(calls, 2, "completed results are never cached");
});

test("in-flight sharing includes request parameters and the current document version", async t => {
  const f = fixture(); t.after(() => f.service.shutdown()); f.connect(); await settled(f.service);
  const middleware = f.clients[0].clientOptions.middleware, held = barrier(), entered = barrier(); let calls = 0;
  const params = { textDocument: { uri: "file:///same.bsl" }, range: { start: { line: 0, character: 0 }, end: { line: 1, character: 0 } } };
  /** Different requested ranges must never reuse another consumer's response. */
  const next = () => { if (++calls === 2) entered.release(); return held.promise; };
  const one = middleware.sendRequest("textDocument/inlayHint", params, undefined, next);
  const two = middleware.sendRequest("textDocument/inlayHint", { ...params, range: { ...params.range, end: { line: 2, character: 0 } } }, undefined, next);
  await entered.promise; assert.equal(calls, 2);
  const stale = Promise.all([assert.rejects(one), assert.rejects(two)]);
  f.advanceDocument();
  assert.deepEqual(await middleware.sendRequest("textDocument/inlayHint", params, undefined, async () => { calls++; return ["new version"]; }), ["new version"]);
  held.release(["old version"]); await stale; assert.equal(calls, 3);
});

test("closing and reopening the same URI cannot share a response from its previous document lifetime", async t => {
  const f = fixture(); t.after(() => f.service.shutdown()); f.connect(); await settled(f.service);
  const middleware = f.clients[0].clientOptions.middleware, held = barrier(), entered = barrier(), params = { textDocument: { uri: "file:///same.bsl" } };
  const old = middleware.sendRequest("textDocument/documentSymbol", params, undefined, () => { entered.release(); return held.promise; });
  const stale = assert.rejects(old); await entered.promise; f.reopenDocument();
  assert.deepEqual(await middleware.sendRequest("textDocument/documentSymbol", params, undefined, async () => ["reopened"]), ["reopened"]);
  held.release(["closed document"]); await stale;
});

test("cancelling one shared caller does not cancel the remaining reader", async t => {
  const f = fixture(); t.after(() => f.service.shutdown()); f.connect(); await settled(f.service);
  const middleware = f.clients[0].clientOptions.middleware, held = barrier(), entered = barrier(), firstToken = f.cancellation(), secondToken = f.cancellation();
  const params = { textDocument: { uri: "file:///same.bsl" } }; let upstream, calls = 0;
  /** The upstream token belongs to the group rather than either editor caller. */
  const next = (_type, _params, token) => { upstream = token; calls++; entered.release(); return held.promise; };
  const one = middleware.sendRequest("textDocument/documentSymbol", params, firstToken.token, next);
  const two = middleware.sendRequest("textDocument/documentSymbol", params, secondToken.token, next);
  const cancelled = assert.rejects(one);
  await entered.promise; firstToken.cancel(); await cancelled;
  assert.equal(upstream.isCancellationRequested, false); assert.equal(calls, 1);
  held.release(["valid for second caller"]); assert.deepEqual(await two, ["valid for second caller"]);
});

test("cancelling every subscriber cancels upstream immediately without poisoning an identical later request", async t => {
  const f = fixture(); t.after(() => f.service.shutdown()); f.connect(); await settled(f.service);
  const middleware = f.clients[0].clientOptions.middleware, held = barrier(), entered = barrier(), firstToken = f.cancellation(), secondToken = f.cancellation();
  const params = { textDocument: { uri: "file:///same.bsl" } }; let upstream;
  /** An uncooperative peer can reply late even after the shared cancellation has been delivered. */
  const next = (_type, _params, token) => { upstream = token; entered.release(); return held.promise; };
  const one = middleware.sendRequest("textDocument/documentSymbol", params, firstToken.token, next);
  const two = middleware.sendRequest("textDocument/documentSymbol", params, secondToken.token, next);
  const cancelled = Promise.all([assert.rejects(one), assert.rejects(two)]);
  await entered.promise; firstToken.cancel(); secondToken.cancel(); await cancelled;
  assert.equal(upstream.isCancellationRequested, true);
  assert.deepEqual(await middleware.sendRequest("textDocument/documentSymbol", params, undefined, async () => ["fresh"]), ["fresh"]);
  held.release(["obsolete"]);
});

test("model invalidation cancels every shared subscription before an obsolete upstream reply", async t => {
  const f = fixture(); t.after(() => f.service.shutdown()); f.connect(); await settled(f.service);
  const middleware = f.clients[0].clientOptions.middleware, held = barrier(), entered = barrier();
  const params = { textDocument: { uri: "file:///same.bsl" } }; let upstream;
  /** Both consumers refer to the old model even if the peer ignores cancellation. */
  const next = (_type, _params, token) => { upstream = token; entered.release(); return held.promise; };
  const one = middleware.sendRequest("textDocument/documentSymbol", params, undefined, next);
  const two = middleware.sendRequest("textDocument/documentSymbol", params, undefined, next);
  const cancelled = Promise.all([assert.rejects(one), assert.rejects(two)]);
  await entered.promise; f.changeDocument(); await cancelled;
  assert.equal(upstream.isCancellationRequested, true);
  assert.deepEqual(await middleware.sendRequest("textDocument/documentSymbol", params, undefined, async () => ["current model"]), ["current model"]);
  held.release(["obsolete"]);
});

test("a shared upstream rejection remains a rejection and does not cache a failed operation", async t => {
  const f = fixture(); t.after(() => f.service.shutdown()); f.connect(); await settled(f.service);
  const middleware = f.clients[0].clientOptions.middleware, held = barrier(), params = { textDocument: { uri: "file:///same.bsl" } }; let calls = 0;
  /** Even an unstructured rejection must never become an apparently successful empty response. */
  const next = async () => { calls++; await held.promise; return Promise.reject(undefined); };
  const one = middleware.sendRequest("textDocument/documentSymbol", params, undefined, next);
  const two = middleware.sendRequest("textDocument/documentSymbol", params, undefined, next);
  const failed = Promise.all([assert.rejects(one), assert.rejects(two)]);
  held.release(); await failed; assert.equal(calls, 1);
  assert.deepEqual(await middleware.sendRequest("textDocument/documentSymbol", params, undefined, async () => { calls++; return ["retry"]; }), ["retry"]);
  assert.equal(calls, 2);
});

test("semantic tokens and symbols remain independent background providers", { timeout: 5000 }, async t => {
  const f = fixture(); t.after(() => f.service.shutdown()); f.connect(); await settled(f.service);
  const middleware = f.clients[0].clientOptions.middleware, held = barrier(), entered = barrier();
  const document = { uri: { toString: () => "file:///same.bsl" }, version: 1, isClosed: false }, params = { textDocument: { uri: document.uri.toString() } };
  const token = { isCancellationRequested: false };
  const symbols = middleware.provideDocumentSymbols(document, token,
    () => middleware.sendRequest("textDocument/documentSymbol", params, undefined, () => { entered.release(); return held.promise; }));
  await entered.promise;
  assert.deepEqual(await middleware.provideDocumentSemanticTokens(document, token,
    () => middleware.sendRequest("textDocument/semanticTokens/full", params, undefined, async () => [0, 0, 5, 0, 0])), [0, 0, 5, 0, 0]);
  held.release(["symbol"]); assert.deepEqual(await symbols, ["symbol"]);
});

test("root-descriptor changes replace the old client only after releasing its lease and drop its diagnostics", async t => {
  const f = fixture(); t.after(() => f.service.shutdown()); f.connect(); await settled(f.service);
  const old = f.clients[0], published = [], uri = { toString: () => "file:///old.bsl" };
  f.dto.status = "stale"; f.dto.ownership.input_fingerprint = "e".repeat(64);
  f.service.sourceChanged(join(f.root, "src", "Configuration.xml"));
  old.clientOptions.middleware.handleDiagnostics(uri, ["old diagnostic"], (_uri, values) => published.push(values));
  assert.equal(f.service.configurationPending, true); assert.equal(published.length, 0);
  await configurationSettled(f.service);
  assert.equal(f.owners.length, 2); assert.equal(f.owners[0].stopped, true); assert.equal(f.watchers[0].disposed, true);
  assert.equal(published.length, 0);
  const release = f.calls.indexOf("analyzer/release"), prepare = f.calls.lastIndexOf("analyzer/configPrepare");
  assert.ok(release >= 0 && release < prepare);
  old.clientOptions.middleware.handleDiagnostics(uri, ["late diagnostic"], (_uri, values) => published.push(values));
  assert.equal(published.length, 0); assert.equal(f.leased, true);
});

test("a same-byte config event resumes its buffered diagnostics without restarting the LSP", async t => {
  const f = fixture(); t.after(() => f.service.shutdown()); f.connect(); await settled(f.service);
  const published = [], middleware = f.clients[0].clientOptions.middleware, uri = { toString: () => "file:///same.bsl" };
  f.watchers[0].fire();
  middleware.handleDiagnostics(uri, ["superseded"], (_uri, values) => published.push(values));
  middleware.handleDiagnostics(uri, ["latest"], (_uri, values) => published.push(values));
  await configurationSettled(f.service);
  assert.deepEqual(published, [["latest"]]); assert.equal(f.owners.length, 1); assert.equal(f.service.configurationPending, false);
});

test("a diagnostic buffered before a document changes cannot reappear after the config barrier", async t => {
  const f = fixture(); t.after(() => f.service.shutdown()); f.connect(); await settled(f.service);
  const published = [], uri = { toString: () => "file:///same.bsl" };
  f.watchers[0].fire();
  f.clients[0].clientOptions.middleware.handleDiagnostics(uri, ["old buffer"], (_uri, values) => published.push(values));
  f.advanceDocument(); await configurationSettled(f.service);
  assert.equal(published.length, 0); assert.equal(f.owners.length, 1);
});

test("same-byte config events restore existing diagnostics when upstream emits no replacement", async t => {
  const f = fixture(); t.after(() => f.service.shutdown()); f.connect(); await settled(f.service);
  const uri = { toString: () => "file:///same.bsl" }, collection = f.clients[0].diagnostics;
  collection.set(uri, ["still current"]);
  f.watchers[0].fire(); f.watchers[0].fire();
  assert.equal(collection.get(uri), undefined);
  await configurationSettled(f.service);
  assert.deepEqual(collection.get(uri), ["still current"]); assert.equal(f.owners.length, 1);
  f.watchers[0].fire(); f.advanceDocument(); await configurationSettled(f.service);
  assert.equal(collection.get(uri), undefined);
});

test("BSL-only and foreign-project changes never prepare another configuration", async t => {
  const f = fixture(); t.after(() => f.service.shutdown()); f.connect(); await settled(f.service);
  const before = f.service.modelRevision, checks = f.calls.filter(value => value === "analyzer/configStatus").length;
  f.service.sourceChanged(join(f.root, "src", "module.bsl"));
  f.metadata({ supportUnchanged: true });
  assert.equal(f.service.modelRevision, before + 2);
  f.service.sourceChanged(join(f.root, "outside", "Configuration.xml")); f.metadata({ projectId: "other" });
  assert.equal(f.service.modelRevision, before + 2);
  await configurationSettled(f.service);
  assert.equal(f.calls.filter(value => value === "analyzer/configStatus").length, checks); assert.equal(f.owners.length, 1);
});

test("a user-modified managed config stops the owned LSP without preparing or overwriting it", async t => {
  const f = fixture(); t.after(() => f.service.shutdown()); f.connect(); await settled(f.service);
  f.dto.status = "managed_conflict"; f.watchers[0].fire(); await configurationSettled(f.service);
  assert.equal(f.owners.length, 1); assert.equal(f.owners[0].stopped, true); assert.equal(f.leased, false);
  assert.equal(f.tooling.states.analyzer.phase, "error"); assert.equal(f.calls.filter(value => value === "analyzer/configPrepare").length, 0);
});

test("a context-check reply arriving after a conflict cannot restart its discarded client", async t => {
  const f = fixture(); t.after(() => f.service.shutdown()); f.connect(); await settled(f.service);
  f.holdAt("analyzer/configStatus"); f.watchers[0].fire(); await f.waiting.promise;
  f.setAvailable(true); await settled(f.service);
  f.pause.release(); await configurationSettled(f.service);
  assert.equal(f.owners.length, 1); assert.equal(f.owners[0].stopped, true);
  assert.equal(f.tooling.states.analyzer.phase, "suspended-conflict"); assert.equal(f.leased, false);
});

test("application sources outside metadata selection receive scoped observers without another metadata session", async t => {
  const f = fixture({ outside: true }); t.after(() => f.service.shutdown()); f.connect(); await settled(f.service);
  assert.equal(f.watchers.length, 3, "config, uncovered source and its member manifest");
  assert.deepEqual(f.policyRoots[0], [f.sourceRoot], "only uncovered backend roots need a separate permission scope");
  const model = f.service.modelRevision;
  for (const path of [join(f.sourceRoot, 'src', '.eska', 'cache'), join(f.sourceRoot, 'src', '.git', 'index'), join(f.root, 'elsewhere.xml')]) {
    f.watchers[1].fire({ fsPath: path });
  }
  assert.equal(f.service.modelRevision, model);
  f.watchers[1].fire({ fsPath: join(f.sourceRoot, 'src', 'Catalogs', 'Item.xml') });
  assert.equal(f.service.modelRevision, model + 1); await configurationSettled(f.service);
  assert.equal(f.owners.length, 1);
  f.dto.status = 'stale'; f.dto.ownership.input_fingerprint = 'e'.repeat(64);
  f.watchers[2].fire(); await configurationSettled(f.service);
  assert.equal(f.owners.length, 2); assert.equal(f.owners[0].stopped, true);
  assert.ok(f.watchers.slice(0, 3).every(watcher => watcher.disposed), "old session observers are all released");
});

/** Virtual file providers must not trigger configuration reloads or native source invalidation through matching fsPath values. */
test("protected view events cannot invalidate analyzer configuration or uncovered sources", async t => {
  const f = fixture({ outside: true }); t.after(() => f.service.shutdown()); f.connect(); await settled(f.service);
  const model = f.service.modelRevision, checks = f.calls.filter(value => value === "analyzer/configStatus").length;
  f.watchers[0].fire({ scheme: "eska-protected", fsPath: join(f.root, "bsl-analyzer.toml") });
  f.watchers[1].fire({ scheme: "eska-protected", fsPath: join(f.sourceRoot, "src", "Catalogs", "Item.xml") });
  f.watchers[2].fire({ scheme: "eska-protected", fsPath: join(f.sourceRoot, "eska.toml") });
  await configurationSettled(f.service);
  assert.equal(f.service.modelRevision, model);
  assert.equal(f.service.configurationPending, false);
  assert.equal(f.calls.filter(value => value === "analyzer/configStatus").length, checks);
  assert.equal(f.owners.length, 1);
});

test("a projection and restore invalidate an ordinary read even when its native owner version never changes", async t => {
  const f = fixture(); t.after(() => f.service.shutdown()); f.connect(); await settled(f.service);
  const client = f.clients[0], held = barrier(), started = barrier();
  const stream = { epoch: 1, projected: () => false, settled: async () => {} };
  f.service.session.documents = stream;
  const reply = client.clientOptions.middleware.sendRequest("textDocument/definition", { textDocument: { uri: "file:///same.bsl" } }, undefined,
    () => { started.release(); return held.promise; });
  await started.promise;
  stream.epoch += 2;
  held.release("offsets from the previous projected model");
  await assert.rejects(reply, error => error.code === LSPErrorCodes.RequestCancelled);
});

test("restored native symbols cannot share the in-flight result from a previous projection model", async t => {
  const f = fixture(); t.after(() => f.service.shutdown()); f.connect(); await settled(f.service);
  const middleware = f.clients[0].clientOptions.middleware, held = barrier(), started = barrier();
  const stream = { epoch: 1, projected: () => false, settled: async () => {} };
  f.service.session.documents = stream;
  const params = { textDocument: { uri: "file:///same.bsl" } };
  let calls = 0;
  const old = middleware.sendRequest("textDocument/documentSymbol", params, undefined,
    () => { calls++; started.release(); return held.promise; });
  await started.promise; stream.epoch += 2;
  const fresh = await middleware.sendRequest("textDocument/documentSymbol", params, undefined, async () => { calls++; return ["current symbols"]; });
  assert.deepEqual(Array.from(fresh), ["current symbols"]); assert.equal(calls, 2);
  held.release(["old symbols"]); await assert.rejects(old, error => error.code === LSPErrorCodes.RequestCancelled);
});
