import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { nodeKey } from "../out/tree.js";

/** Exercise the real tab controller with deterministic visibility and delayed backend responses. */
function fixture(t) {
  const requests = [], opened = [];
  const vscode = {
    workspace: { isTrusted: true, textDocuments: [] },
    env: { language: "ru-RU" }, ViewColumn: { Active: -1 },
    Uri: { joinPath: (...parts) => parts.join("/") },
    window: { createWebviewPanel: () => {
      let viewChanged, closed;
      return {
        visible: true, title: "", viewColumn: 1,
        webview: { cspSource: "local:", asWebviewUri: value => value, onDidReceiveMessage() {}, postMessage() {} },
        onDidChangeViewState(listener) { viewChanged = listener; },
        onDidDispose(listener) { closed = listener; },
        reveal() { this.setVisible(true); },
        setVisible(visible) { this.visible = visible; viewChanged(); },
        dispose() { closed(); },
      };
    } },
  };
  const require = createRequire(new URL("../out/properties-view.js", import.meta.url));
  const adapter = { exports: {} };
  runInNewContext(`(function(require,module,exports){${readFileSync(new URL("../out/properties-view.js", import.meta.url), "utf8")}\n})`, { AbortController })(
    name => name === "vscode" ? vscode : require(name), adapter, adapter.exports);
  const project = { key: "project", nodes: new Map(), info: { generation: "1", eventSequence: "0", scope: { kind: "standalone" }, type: "configuration", sourcePath: { value: "/project/src", encoding: "utf-8" } } };
  const tree = {
    connection: {},
    parent: entry => entry.node.parent ? project.nodes.get(nodeKey(entry.node.parent)) : undefined,
    request: (_project, _method, _params, signal) => new Promise((resolve, reject) => requests.push({ resolve, reject, signal, method: _method, params: _params, project: _project })),
  };
  let currentTree = tree;
  const tabs = new adapter.exports.PropertyTabs({ extensionUri: "/extension" }, () => "ru-RU", () => currentTree,
    async (_entry, choice) => { opened.push(choice.label); });
  t.after(() => tabs.dispose());
  /** Link actual node identities so ancestor invalidations can be tested independently of labels. */
  function entry(name, parent) {
    const node = { id: { kind: "object", objectId: name }, parent: parent?.node.id, label: { kind: "name", text: name } };
    const value = { node, project };
    project.nodes.set(nodeKey(node.id), value);
    return value;
  }
  const root = entry("root");
  const object = entry("object", root);
  const sibling = entry("sibling", root);
  /** Advance backend tokens; a repaint without a token change is not a data invalidation. */
  function change(entries) {
    project.info.eventSequence = String(Number(project.info.eventSequence) + 1);
    tabs.changed(tree, entries);
  }
  return { tabs, tree, root, object, sibling, requests, opened, change,
    replaceTree(value) { currentTree = value; } };
}

/** Keep raw property ranges and order in responses, including deliberately reordered snapshots. */
function response(names = ["Name", "Comment"]) {
  return { properties: names.map((name, i) => ({ key: { namespace: null, name }, range: { start: i * 10, end: i * 10 + 9 },
    value: { kind: "text", text: name } })) };
}

/** Allow a fire-and-forget visibility refresh to publish its resolved state. */
async function settle() { await new Promise(resolve => setImmediate(resolve)); }

test("focus and unrelated repaints do not reload; hidden invalidations are coalesced", async t => {
  const f = fixture(t);
  const opening = f.tabs.show(f.tree, f.object);
  f.requests[0].resolve(response());
  await opening;
  const [tab] = f.tabs.tabs.values();
  tab.panel.setVisible(true);
  tab.panel.setVisible(false);
  tab.panel.setVisible(true);
  f.tabs.changed(f.tree, [f.object]);
  f.change([f.sibling]);
  assert.equal(f.requests.length, 1);
  f.change([f.root]);
  assert.equal(f.requests.length, 2, "ancestor invalidation includes the object");
  f.requests[1].resolve(response());
  await settle();
  tab.panel.setVisible(false);
  f.change([f.object]);
  f.change([f.object]);
  assert.equal(f.requests.length, 2);
  tab.panel.setVisible(true);
  tab.panel.setVisible(true);
  assert.equal(f.requests.length, 3);
  f.requests[2].resolve(response());
  await settle();
  tab.panel.setVisible(false);
  f.change([f.object]);
  const reopening = f.tabs.show(f.tree, f.object);
  assert.equal(f.requests.length, 4, "revealing an invalidated tab starts exactly one read");
  f.requests[3].resolve(response());
  await reopening;
  assert.equal(tab.state.status, "ready");
});

test("XML clicks are bound to the displayed revision even when properties move", async t => {
  const f = fixture(t);
  const opening = f.tabs.show(f.tree, f.object);
  f.requests[0].resolve(response());
  await opening;
  const [tab] = f.tabs.tabs.values();
  const old = { type: "openXml", index: 1, revision: tab.state.revision };
  f.change([f.object]);
  await tab.receive(old);
  f.requests[1].resolve(response(["Comment", "Name"]));
  await settle();
  await tab.receive(old);
  await tab.receive({ type: "openXml", index: 1 });
  assert.deepEqual(f.opened, []);
  await tab.receive({ type: "openXml", index: 0, revision: tab.state.revision });
  assert.deepEqual(f.opened, ["Comment"]);
});

test("late responses cannot replace refreshed data or revive disconnected tabs", async t => {
  const f = fixture(t);
  const opening = f.tabs.show(f.tree, f.object);
  const [tab] = f.tabs.tabs.values();
  f.change([f.object]);
  assert.equal(f.requests[0].signal.aborted, true);
  f.requests[1].resolve(response(["Current"]));
  await settle();
  f.requests[0].resolve(response(["Old"]));
  await opening;
  assert.equal(tab.choices[0].label, "Current");
  f.change([f.object]);
  f.replaceTree(undefined);
  f.tabs.stale();
  f.requests[2].resolve(response(["After disconnect"]));
  await settle();
  tab.panel.setVisible(true);
  assert.equal(tab.state.status, "stale");
  assert.equal(f.requests.length, 3);
  f.replaceTree(f.tree);
  const reopening = f.tabs.show(f.tree, f.object);
  f.requests[3].resolve(response(["Reconnected"]));
  await reopening;
  assert.equal(tab.choices[0].label, "Reconnected");
  tab.dispose();
  assert.equal(f.tabs.tabs.size, 0);
});

test("a hidden failed tab recovers after its object changes", async t => {
  const f = fixture(t);
  const opening = f.tabs.show(f.tree, f.object);
  f.requests[0].reject(new Error("unavailable"));
  await opening;
  const [tab] = f.tabs.tabs.values();
  assert.equal(tab.state.status, "error");
  tab.panel.setVisible(false);
  f.change([f.object]);
  tab.panel.setVisible(true);
  f.requests[1].resolve(response());
  await settle();
  assert.equal(tab.state.status, "ready");
});

test("picture failures keep properties available and refresh replaces the displayed image", async t => {
  const f = fixture(t);
  f.object.node.metadataKind = "common-picture";
  const opening = f.tabs.show(f.tree, f.object);
  const [tab] = f.tabs.tabs.values();
  assert.equal(tab.state.picture.status, "loading");
  const first = { status: "ready", mimeType: "image/png", fileName: "100.png", data: "YWJj" };
  f.requests[0].resolve({ ...response(), picture: first });
  await opening;
  assert.equal(tab.state.picture.data, first.data);
  const refresh = tab.receive({ type: "refresh" });
  assert.equal(tab.state.picture.status, "loading");
  f.requests[1].resolve({ ...response(), picture: { status: "missing" } });
  await refresh;
  assert.equal(tab.state.status, "ready");
  assert.equal(tab.state.properties.length, 2);
  assert.equal(tab.state.picture.status, "missing");
  const recovery = tab.receive({ type: "refresh" });
  f.requests[2].resolve({ ...response(), picture: { ...first, data: "bmV3" } });
  await recovery;
  assert.equal(tab.state.picture.data, "bmV3");
  f.tabs.stale();
  assert.equal(tab.state.picture, undefined);
});

/** A derived reference is authorized only by the validated snapshot from the same project. */
function linkedResponse() {
  const value = response(["DefaultForm"]);
  value.properties[0].presentation = { kind: "reference", caption: { "ru-RU": "Форма", "en-US": "Form" },
    category: { "ru-RU": "Общая форма", "en-US": "Common form" }, metadataKind: "common-form", status: "resolved", target: "sibling" };
  return value;
}

test("reference actions reject forged and stale identities and open a separate property tab", async t => {
  const f = fixture(t);
  f.root.project.info.root = f.root.node.id;
  f.tree.root = async () => f.root;
  f.tree.children = async () => [f.object, f.sibling];
  const opening = f.tabs.show(f.tree, f.object);
  f.requests[0].resolve(linkedResponse());
  await opening;
  const [tab] = f.tabs.tabs.values();
  await tab.receive({ type: "openReference", revision: tab.state.revision, target: "forged" });
  await tab.receive({ type: "openReference", revision: tab.state.revision - 1, target: "sibling" });
  assert.equal(f.requests.length, 1);
  const click = tab.receive({ type: "openReference", revision: tab.state.revision, target: "sibling" });
  assert.equal(f.requests[1].method, "metadata/reveal");
  assert.equal(f.requests[1].project, f.object.project);
  f.requests[1].resolve({ ancestry: [f.root.node.id, f.sibling.node.id], generation: "1" });
  await settle();
  assert.equal(f.tabs.tabs.size, 2);
  assert.equal(f.requests[2].params.objectId, "sibling");
  f.requests[2].resolve(response());
  await click;
});

test("reference captions reload when a target changes and late navigation cannot open old tabs", async t => {
  const f = fixture(t);
  f.root.project.info.root = f.root.node.id;
  f.tree.root = async () => f.root;
  f.tree.children = async () => [f.object, f.sibling];
  const opening = f.tabs.show(f.tree, f.object);
  f.requests[0].resolve(linkedResponse());
  await opening;
  const [tab] = f.tabs.tabs.values();
  const click = tab.receive({ type: "openReference", revision: tab.state.revision, target: "sibling" });
  f.change([f.sibling]);
  assert.equal(f.requests.length, 3, "a referenced object's change invalidates the displayed synonym");
  f.requests[1].resolve({ ancestry: [f.root.node.id, f.sibling.node.id], generation: "1" });
  await click;
  assert.equal(f.tabs.tabs.size, 1);
  f.requests[2].resolve(linkedResponse());
  await settle();
});

/** The schema's paths, snapshot and writable flag come from the backend, not webview input. */
function editable(value = "before", snapshot = "a".repeat(64)) {
  return { snapshot, source: { value: "Configuration.xml", encoding: "utf-8" }, writable: true, undo: false, redo: false,
    fields: [{ path: [{ key: { namespace: null, name: "Comment" }, occurrence: 0 }], value, language: null,
      captions: [{ "ru-RU": "Комментарий", "en-US": "Comment" }], schema: { kind: "text" } }] };
}

/** Open locked, then explicitly unlock through the same message path as the webview. */
async function openEditable(f) {
  const opening = f.tabs.show(f.tree, f.object);
  f.requests[0].resolve(response()); await opening;
  const [tab] = f.tabs.tabs.values();
  assert.equal(tab.state.editing.unlocked, false);
  const unlock = tab.receive({ type: "toggleLock", revision: tab.state.revision });
  f.requests[1].resolve(editable()); await unlock;
  assert.equal(tab.state.editing.unlocked, true);
  return tab;
}

test("edits keep drafts through external conflicts and never write while blocked", async t => {
  const f = fixture(t), tab = await openEditable(f);
  const change = { kind: "text", value: "mine" };
  await tab.receive({ type: "draft", revision: tab.state.revision, field: 0, change });
  f.change([f.object]);
  assert.equal(f.requests[2].method, "metadata/propertyEditing");
  f.requests[2].resolve(editable("external", "b".repeat(64))); await settle();
  assert.equal(tab.state.editing.blocked, true);
  assert.equal(Object.values(tab.state.editing.drafts)[0].value, "mine");
  await tab.receive({ type: "commit", revision: tab.state.revision, field: 0, change });
  assert.equal(f.requests.length, 3, "a conflict cannot trigger an automatic overwrite");
  await tab.receive({ type: "openXml", revision: tab.state.revision, index: 0 });
  assert.equal(f.opened.length, 0);
  const reload = tab.receive({ type: "refresh" });
  assert.equal(f.requests[3].method, "metadata/refresh", "explicit reread invalidates the stale backend cache");
  f.requests[3].resolve({}); await settle();
  assert.equal(f.requests[4].method, "metadata/propertyEditing");
  f.requests[4].resolve(editable("external", "b".repeat(64))); await settle();
  f.requests[5].resolve(response()); await reload;
  assert.equal(tab.state.status, "ready");
  assert.equal(tab.state.editing.blocked, false);
  assert.equal(tab.state.editing.busy, false);
  assert.equal(Object.values(tab.state.editing.drafts)[0].value, "mine");
});

test("successful autosave survives its own invalidation and keeps newer draft input", async t => {
  const f = fixture(t), tab = await openEditable(f);
  const revision = tab.state.revision;
  const saving = tab.receive({ type: "commit", revision, field: 0, change: { kind: "text", value: "first" } });
  assert.equal(f.requests[2].method, "metadata/updateProperty");
  assert.equal(f.requests[2].params.snapshot, "a".repeat(64));
  f.change([f.object]);
  assert.equal(f.requests.length, 3);
  await tab.receive({ type: "draft", revision, field: 0, change: { kind: "text", value: "second" } });
  f.requests[2].resolve({ ...response(), editing: { ...editable("first", "b".repeat(64)), undo: true } });
  await settle();
  f.requests[3].resolve(editable("first", "b".repeat(64))); await saving;
  assert.equal(tab.state.editing.blocked, false);
  assert.equal(Object.values(tab.state.editing.drafts)[0].value, "second");
  assert.equal(tab.state.editing.schema.undo, true);
  await tab.receive({ type: "cancelDraft", revision: tab.state.revision, field: 0 });
  assert.equal(Object.keys(tab.state.editing.drafts).length, 0);
});

test("unknown write outcomes preserve input; re-opening creates a locked tab", async t => {
  const f = fixture(t), tab = await openEditable(f);
  const saving = tab.receive({ type: "commit", revision: tab.state.revision, field: 0, change: { kind: "text", value: "keep" } });
  f.requests[2].reject(new Error("connection ended after dispatch")); await saving;
  assert.equal(f.requests.length, 3);
  assert.equal(tab.state.editing.blocked, true);
  assert.equal(Object.values(tab.state.editing.drafts)[0].value, "keep");
  tab.dispose();
  const opening = f.tabs.show(f.tree, f.object);
  f.requests[3].resolve(response()); await opening;
  const [reopened] = f.tabs.tabs.values();
  assert.equal(reopened.state.editing.unlocked, false);
});
