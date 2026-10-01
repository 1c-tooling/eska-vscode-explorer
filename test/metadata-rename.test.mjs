import { test } from "node:test";
import assert from "node:assert/strict";
import { renameTransition, renamedIdentity, renamePlan } from "../out/metadata-rename.js";
import { ExplorerError } from "../out/protocol.js";
import { MetadataTree, nodeKey } from "../out/tree.js";
import { Connection } from "../out/connection.js";

/** Opaque IDs need no client-side metadata grammar, including a backend-supplied descendant delimiter. */
test("rename remapping accepts only the exact object and advertised descendant prefix", () => {
  const change = renameTransition({ from: "a", to: "b", descendantFrom: "old::", descendantTo: "new::" });
  assert.equal(renamedIdentity("a", change), "b");
  assert.equal(renamedIdentity("old::leaf", change), "new::leaf");
  assert.equal(renamedIdentity("ab", change), "ab");
  assert.throws(() => renameTransition({ from: "", to: "b" }), { code: "protocolInvalid" });
});

/** Remapping occurs before listeners run, retaining the entry objects already held by property tabs. */
test("tree rename migrates owners, descendants and parent links before invalidation", () => {
  let notify;
  const connection = { onNotification(listener) { notify = listener; return { dispose() {} }; } };
  const info = { projectId: "p", scope: { kind: "standalone" }, rootPath: { value: "/p", encoding: "utf-8" },
    root: { kind: "object", objectId: "old" }, generation: "0", eventSequence: "0", requiresRefresh: false, requiresReopen: false };
  const tree = new MetadataTree(connection, { sessionId: "s", projects: [info] }, () => {
    assert.equal(project.nodes.get(nodeKey({ kind: "object", objectId: "new" })), owner);
  }, () => assert.fail("unexpected recovery"));
  const project = tree.projects[0];
  const owner = { project, node: { id: info.root, parent: null }, previousChildren: [] };
  const child = { project, node: { id: { kind: "object", objectId: "old/field" }, parent: info.root }, previousChildren: [] };
  const module = { project, node: { id: { kind: "module", owner: "old", role: "object" }, parent: info.root }, previousChildren: [] };
  const other = { project, node: { id: { kind: "object", objectId: "older" }, parent: null }, previousChildren: [] };
  for (const entry of [owner, child, module, other]) project.nodes.set(nodeKey(entry.node.id), entry);
  notify("metadata/changed", { sessionId: "s", projectId: "p", generation: "1", eventSequence: "1", affected: null,
    requiresRefresh: false, requiresReopen: false, renamed: { from: "old", to: "new", descendantFrom: "old/", descendantTo: "new/" } });
  assert.equal(child.node.id.objectId, "new/field");
  assert.equal(tree.parent(child), owner);
  assert.equal(module.node.id.owner, "new");
  assert.equal(other.node.id.objectId, "older");
  assert.equal(project.info.root.objectId, "new");
  assert.equal(project.nodes.has(nodeKey(info.root)), false);
  tree.dispose();
});

/** A closed preview cannot release queued reads into a backend which is still doing an uninterruptible scan. */
test("structural requests hold the timeout barrier until the actual backend reply", async () => {
  const calls = [];
  let release;
  const connection = new Connection("test", () => {}, () => {});
  connection.current = { kind: "ready", session: { sessionId: "s" } };
  connection.child = { request(method, _params, timeout, signal) {
    calls.push({ method, timeout, signal });
    return method === "metadata/renamePreview" ? new Promise(resolve => { release = resolve; }) : Promise.resolve({ done: true });
  } };
  const controller = new AbortController();
  const rename = connection.request("s", "metadata/renamePreview", {}, controller.signal);
  const rejected = assert.rejects(rename, { code: "cancelled" });
  const reading = connection.request("s", "metadata/properties");
  controller.abort();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls.length, 1);
  assert.equal(calls[0].timeout, 600_000);
  assert.equal(calls[0].signal, undefined);
  release({ plan: {} });
  await rejected;
  assert.deepEqual(await reading, { done: true });
  assert.equal(calls.length, 2);
});

/** A stale generation or ambiguous failure must not cause a second structural write. */
test("rename apply never retries a failed mutation", async () => {
  for (const domain of ["stale_generation", "resync_required", "rename_committed_refresh_required"]) {
    let calls = 0;
    const error = new ExplorerError("requestFailed", domain);
    const connection = { onNotification() { return { dispose() {} }; }, request() { calls++; throw error; } };
    const info = { projectId: "p", scope: { kind: "standalone" }, rootPath: { value: "/p", encoding: "utf-8" },
      root: { kind: "object", objectId: "old" }, generation: "0", eventSequence: "0", requiresRefresh: false, requiresReopen: false };
    const tree = new MetadataTree(connection, { sessionId: "s", projects: [info] }, () => {}, () => assert.fail("unexpected recovery"));
    try {
      await assert.rejects(tree.request(tree.projects[0], "metadata/renameApply"), failure => failure === error);
      assert.equal(calls, 1);
    } finally { tree.dispose(); }
  }
});

/** Malformed navigation ranges and snapshots must not reach the review webview. */
test("rename plans validate every file range and publication token", () => {
  const plan = { objectId: "a", newObjectId: "b", oldName: "A", newName: "B", snapshot: "a".repeat(64),
    files: [{ path: "A.xml", snapshot: "b".repeat(64), replacements: [{ range: { start: 0, end: 1 }, before: "A", after: "B" }], uncertain: [] }], moves: [], issues: [] };
  assert.equal(renamePlan({ plan }), plan);
  for (const mutate of [
    p => { p.snapshot = "invalid"; }, p => { p.files[0].snapshot = "invalid"; },
    p => { p.files[0].replacements[0].range.start = -1; },
    p => { p.files[0].replacements[0].range.end = 0.5; },
    p => { p.files[0].uncertain = [{ range: { start: 5, end: 4 }, text: "A", reason: "string" }]; },
  ]) {
    const invalid = structuredClone(plan); mutate(invalid);
    assert.throws(() => renamePlan({ plan: invalid }), { code: "protocolInvalid" });
  }
});
