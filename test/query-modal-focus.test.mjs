import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";

/** Load unchanged compiled adapters with a scoped native boundary; no global module mocks can escape. */
function nativeAdapters(vscode) {
  const modules = new Map();
  const load = filename => {
    if (modules.has(filename)) return modules.get(filename).exports;
    const module = { exports: {} }, require = createRequire(filename);
    modules.set(filename, module);
    runInNewContext(`(function(require,module,exports,__filename,__dirname){${readFileSync(filename, "utf8")}\n})`, {
      process, Buffer, URL, setTimeout, clearTimeout,
    })(name => name === "vscode" ? vscode : name.startsWith(".") ? load(require.resolve(name)) : require(name),
      module, module.exports, filename, dirname(filename));
    return module.exports;
  };
  return name => load(fileURLToPath(new URL(`../out/query/${name}.js`, import.meta.url)));
}

/** Native focus can retain a dirty parent's TextEditor while its child webview is already foreground. */
function guardFixture({ dirty = true, close = () => true } = {}) {
  const owner = { toString: () => "file:///owner.xml" }, draft = { toString: () => "eska-query:///draft.sdbl" };
  const parentTabs = [{ isDirty: dirty }], errors = [], closed = [];
  let focused = 0;
  const vscode = { window: { activeTextEditor: { document: { uri: owner } }, tabGroups: {
    all: [], async close(tabs) { closed.push(tabs); return close(parentTabs, tabs); },
  } } };
  const { QueryTabs } = nativeAdapters(vscode)("tabs");
  const session = { record: { id: "session" }, design: { parentLocked: true },
    parent: { active: true, tabs: () => parentTabs, contains: uri => uri === owner } };
  const adapter = Object.assign(Object.create(QueryTabs.prototype), {
    sessions: new Map([[session.record.id, session]]), currentTree: () => undefined, uri: () => draft,
    async focus() { if (++focused > 3) throw new Error("focus feedback loop"); },
    failure(error) { errors.push(error); },
  });
  return { adapter, session, parentTabs, errors, closed, focused: () => focused };
}

/** Let the entire guarded promise/finally chain settle; the fail-safe bounds a regressed microtask loop. */
async function settled(value) {
  value.adapter.guardParents();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(value.session.guarding, undefined);
  assert.deepEqual(value.errors, []);
}

test("dirty XML parent behind a constructor does not schedule a focus feedback loop", async () => {
  const value = guardFixture();
  await settled(value);
  assert.equal(value.focused(), 1);
  assert.equal(value.closed.length, 0);
  assert.equal(value.parentTabs[0].isDirty, true);
  assert.equal(value.session.parent.active, true);
});

test("refused native close does not retry without a new parent event", async () => {
  const value = guardFixture({ dirty: false, close: () => false });
  await settled(value);
  assert.equal(value.focused(), 1);
  assert.equal(value.closed.length, 1);
  assert.equal(value.parentTabs.length, 1);
});

test("a completed close rechecks a late parent tab and preserves its dirty buffer", async () => {
  let closes = 0;
  const value = guardFixture({ dirty: false, close(tabs) {
    tabs.splice(0, tabs.length, { isDirty: ++closes === 2 });
    return true;
  } });
  await settled(value);
  assert.equal(value.closed.length, 2);
  assert.ok(value.focused() <= 3);
  assert.equal(value.parentTabs[0].isDirty, true);
  assert.equal(value.session.parent.active, true);
});

test("constructor reveal is idempotent when the panel is already active", async () => {
  let reveal, focused = 0;
  const panel = { active: true, webview: { onDidReceiveMessage() {} }, onDidDispose() {},
    reveal() { focused++; this.active = true; } };
  const binding = { onReveal(action) { reveal = action; } };
  const uri = { toString: () => "eska-query:///draft.sdbl" };
  const vscode = { ViewColumn: { Active: -1 }, Uri: { joinPath: () => ({}) },
    workspace: { async openTextDocument() { return {}; } }, window: { createWebviewPanel: () => panel } };
  const { QueryDesigner } = nativeAdapters(vscode)("designer");
  const designer = Object.assign(Object.create(QueryDesigner.prototype), { views: new Map(),
    context: { extensionUri: {} }, tabs: { async beginConstructor() { return binding; } }, text: () => "Constructor", html: () => "" });
  await designer.open(uri);
  reveal(); assert.equal(focused, 0);
  panel.active = false;
  reveal(); assert.equal(focused, 1);
  reveal(); assert.equal(focused, 1);
});

/** File saves can invalidate an owner between metadata/source and query/open. */
function openingFixture(drain = () => {}) {
  const load = nativeAdapters({}), { QueryTabs } = load("tabs"), { ExplorerError } = load("../protocol");
  const project = { info: { generation: "0", eventSequence: "0" } }, opened = [], closed = [];
  const tree = { connection: { state: { kind: "ready", queryEditing: {} } }, session: { sessionId: "test" },
    async synchronizeInputs() { await drain(project); } };
  load("client").QueryClient = class {
    async open(owner) { opened.push(owner); return { async close() { closed.push(owner); } }; }
  };
  const adapter = Object.assign(Object.create(QueryTabs.prototype), {
    currentTree: () => tree, recoveryAvailable: true, requiredRecovery() {}, application() {},
  });
  const locate = () => ({ entry: { project, node: { id: project.info.generation } }, source: {},
    document: { version: 1, getText: () => "query" } });
  return { adapter, tree, project, opened, closed, locate, ExplorerError };
}

test("a queued save resolves a fresh owner before allocating exactly one query document", async () => {
  let barriers = 0, located = 0, actions = 0;
  const value = openingFixture(project => { if (++barriers === 2) project.info.generation = "1"; });
  const result = await value.adapter.withDocument(value.tree, value.project,
    async () => { located++; return value.locate(); }, async (_document, owner) => { actions++; return owner.entry.node.id; });
  assert.equal(result, "1"); assert.equal(located, 2); assert.equal(actions, 1);
  assert.equal(value.opened.length, 1); assert.equal(value.opened[0].node, "1"); assert.equal(value.closed.length, 1);
});

test("only stale read-only owner discovery retries after an ordered invalidation", async () => {
  const value = openingFixture(); let located = 0;
  await value.adapter.withDocument(value.tree, value.project, async () => {
    if (++located === 1) { value.project.info.eventSequence = "1"; throw new value.ExplorerError("sourceChanged"); }
    return value.locate();
  }, async () => {});
  assert.equal(located, 2); assert.equal(value.opened.length, 1); assert.equal(value.closed.length, 1);
});

test("unstable owner discovery stops without allocating a query document", async () => {
  const value = openingFixture(); let located = 0;
  await assert.rejects(value.adapter.withDocument(value.tree, value.project, async () => {
    value.project.info.eventSequence = String(++located); throw new value.ExplorerError("sourceChanged");
  }, async () => assert.fail("action must not run")), { code: "sourceChanged" });
  assert.equal(located, 3); assert.equal(value.opened.length, 0);
});

test("a query action failure closes its document and never replays the action", async () => {
  const value = openingFixture(); let actions = 0;
  await assert.rejects(value.adapter.withDocument(value.tree, value.project, async () => value.locate(), async () => {
    actions++; throw new value.ExplorerError("sourceChanged");
  }), { code: "sourceChanged" });
  assert.equal(actions, 1); assert.equal(value.opened.length, 1); assert.equal(value.closed.length, 1);
});
