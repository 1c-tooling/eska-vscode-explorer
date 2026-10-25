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
