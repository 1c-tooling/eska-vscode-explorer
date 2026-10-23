import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { Connection } from "../out/connection.js";
import { SourceAccess, sourceCapabilities } from "../out/source-access.js";
import { createTreeProject } from "./fixture.mjs";
import { createQuerySource } from "./query-fixture.mjs";

const executable = process.env.ESKA_TEST_BINARY;

/** Real source contexts and files stay inside a unique test-owned sibling-playground project. */
async function fixture(t, locale = "en-US") {
  const root = await mkdtemp(join(process.env.ESKA_TEST_ROOT ?? resolve("../eska-playground"), "explorer-source-view-"));
  const connection = new Connection("source-view-test", () => {}, () => {});
  t.after(async () => { await connection.dispose(); await rm(root, { recursive: true, force: true }); });
  const files = await createTreeProject(join(root, "project"));
  Object.assign(files, await createQuerySource(files));
  const target = { executable, path: files.root, name: "sources", locale };
  await connection.connect(target);
  const state = connection.state;
  assert.equal(state.kind, "ready", JSON.stringify(state));
  assert.ok(connection.sources);
  const project = state.session.projects[0];
  const context = () => ({ sessionId: state.session.sessionId, projectId: project.projectId, generation: project.generation });
  return { ...files, connection, context, target, path: { value: relative(files.source, files.formPath), encoding: "utf-8" },
    client: new SourceAccess(connection.sources, context) };
}

/** Source capabilities cannot grant writes or enlarge native allocation bounds. */
test("common source capability requires binary immutable snapshots and clamps negotiated limits", () => {
  const value = { schemaVersion: 1, writesOwner: false, sessionOwnerPriority: true, binarySnapshots: true, sharedQueryBudget: true,
    maxSnapshotBytes: 8_388_608, maxSnapshots: 16, maxRetainedBytes: 33_554_432, maxChunkBytes: 131_072, maxPaths: 128 };
  const hello = { apiVersion: { major: 1, minor: 17 }, capabilities: { sourceProtection: value } };
  assert.equal(sourceCapabilities(hello).maxSnapshotBytes, 8_388_608);
  assert.equal(sourceCapabilities(hello).rootedPreviews, false);
  assert.equal(sourceCapabilities({ ...hello, apiVersion: { major: 1, minor: 18 },
    capabilities: { sourceProtection: { ...value, rootedPreviews: true } } }).rootedPreviews, true);
  assert.equal(sourceCapabilities({ ...hello, apiVersion: { major: 1, minor: 16 } }), undefined);
  for (const changed of [{ writesOwner: true }, { binarySnapshots: false }, { sharedQueryBudget: false }, { maxChunkBytes: 0 }]) {
    assert.throws(() => sourceCapabilities({ ...hello, capabilities: { sourceProtection: { ...value, ...changed } } }), { code: "protocolInvalid" });
  }
  const limits = sourceCapabilities({ ...hello, capabilities: { sourceProtection: { ...value, maxSnapshotBytes: 999_999_999, maxPaths: 1000 } } });
  assert.equal(limits.maxSnapshotBytes, 8_388_608); assert.equal(limits.maxPaths, 128);
});

for (const locale of ["ru-RU", "en-US"]) test(`source SDK returns exact disk/large native bytes without changing the source (${locale})`,
  { skip: !executable }, async t => {
    const value = await fixture(t, locale);
    const original = await readFile(value.formPath);
    const disk = await value.client.read(value.path);
    assert.equal(disk.header.origin, "disk");
    assert.deepEqual(Buffer.from(disk.bytes), original);
    assert.equal(disk.header.snapshot, createHash("sha256").update(original).digest("hex"));
    const native = '\ufeff// large native 😀\0"quoted"\r\n'.repeat(10000);
    const reader = await value.client.read(value.path, { version: "9007199254740993", text: native, userReadOnly: true });
    assert.equal(reader.header.origin, "editor");
    assert.equal(reader.header.version, "9007199254740993");
    assert.equal(Buffer.from(reader.bytes).toString("utf8"), native);
    assert.equal(reader.header.protection.writable, false);
    const flags = await value.client.protection([{ path: value.path, userReadOnly: false }, { path: value.path, userReadOnly: true }], true);
    assert.equal(flags[0].writable, true); assert.equal(flags[1].writable, false);
    assert.deepEqual(await readFile(value.formPath), original);
  });

/** Invalid binary data and offsets fail before display, while the real backend still receives exact handle cleanup. */
test("source SDK rejects malformed chunks and frees captured handles", { skip: !executable }, async t => {
  const value = await fixture(t);
  const endpoint = value.connection.sources;
  for (const corruption of ["noncanonical", "content", "offset"]) {
    let id, closed = 0, once = true;
    const client = new SourceAccess({ ...endpoint, request: async (method, params) => {
      const result = await endpoint.request(method, params);
      if (method === "source/snapshotOpen") id = result.snapshotId;
      if (method === "source/snapshotClose") closed++;
      if (method === "source/snapshotRead" && once) {
        once = false;
        if (corruption === "noncanonical") result.data += "\n";
        else if (corruption === "content") { const bytes = Buffer.from(result.data, "base64"); bytes[0] ^= 1; result.data = bytes.toString("base64"); }
        else result.nextOffset++;
      }
      return result;
    } }, value.context);
    await assert.rejects(client.read(value.path), { code: "protocolInvalid" });
    assert.equal(closed, 1);
    assert.equal((await endpoint.request("source/snapshotClose", { ...value.context(), snapshotId: id })).released, false);
  }
  assert.equal((await value.client.read(value.path)).header.origin, "disk");
});

/** Process replacement cannot reuse old handles, even when the new process starts its resource counters again. */
test("source SDK cannot address a replacement process through an obsolete endpoint", { skip: !executable }, async t => {
  const value = await fixture(t);
  const first = await value.client.read(value.path);
  await value.connection.connect(value.target);
  await assert.rejects(value.client.read(value.path), { code: "obsolete" });
  const state = value.connection.state;
  assert.equal(state.kind, "ready");
  const project = state.session.projects[0];
  const current = new SourceAccess(value.connection.sources, () => ({ sessionId: state.session.sessionId, projectId: project.projectId, generation: project.generation }));
  const second = await current.read(value.path);
  assert.equal(second.header.snapshotId, first.header.snapshotId);
  assert.equal(second.header.snapshot, first.header.snapshot);
});

/** Native authorization expires before a queued source-lifecycle mutation, while readonly views do not invalidate it. */
test("source mutation freshness changes before the backend reply", { skip: !executable }, async t => {
  const value = await fixture(t);
  const before = value.connection.sourceRevision;
  await value.client.read(value.path);
  assert.equal(value.connection.sourceRevision, before);
  const closing = value.connection.recovery.sessions.request("query/sessionClose", { ...value.context(), querySessionId: "missing" });
  assert.notEqual(value.connection.sourceRevision, before);
  assert.equal((await closing).released, false);
});

/** Restoration can read from a fixed served folder after metadata open fails, without an IDE file reader. */
test("rooted preview SDK works after a manifest failure and retains no project authority", { skip: !executable }, async t => {
  const value = await fixture(t);
  const original = await readFile(value.formPath);
  await rm(join(value.root, "eska.toml"));
  await value.connection.connect(value.target);
  assert.equal(value.connection.state.kind, "error");
  assert.equal(value.connection.state.error.code, "manifestMissing");
  assert.ok(value.connection.sources?.limits.rootedPreviews);
  const client = new SourceAccess(value.connection.sources);
  const view = await client.preview({ value: relative(value.root, value.formPath), encoding: "utf-8" });
  assert.deepEqual(Buffer.from(view.bytes), original);
  assert.equal(view.header.protection.writable, false);
  assert.equal(view.header.protection.supportUnknown, true);
  assert.deepEqual(view.header.protection.objects, []);
  await assert.rejects(client.preview({ value: "../outside.txt", encoding: "utf-8" }));
});

/** A preview response cannot silently become a project source or confer write permission. */
test("rooted preview SDK rejects writable responses and releases the real handle", { skip: !executable }, async t => {
  const value = await fixture(t), endpoint = value.connection.sources;
  const methods = [];
  const client = new SourceAccess({ limits: endpoint.limits, async request(method, params) {
    methods.push(method);
    const result = await endpoint.request(method, params);
    return method === "source/previewOpen" ? { ...result, protection: { ...result.protection, writable: true } } : result;
  } });
  await assert.rejects(client.preview({ value: relative(value.root, value.formPath), encoding: "utf-8" }), { code: "protocolInvalid" });
  assert.deepEqual(methods, ["source/previewOpen", "source/previewClose"]);
});
