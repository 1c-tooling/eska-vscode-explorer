import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, readFile, writeFile, readdir, mkdir, symlink } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { QueryRecovery, parseDraftRecord } from "../out/query/recovery.js";
import { querySnapshot } from "../out/query/client.js";
import { Connection } from "../out/connection.js";
import { MAX_REQUEST } from "../out/protocol.js";
import { recoveryCapabilities, RECOVERY_LIMITS } from "../out/query/recovery-protocol.js";

const executable = process.env.ESKA_TEST_BINARY;
const integration = { skip: !executable };

/** Model a dirty owner independently of the draft, as both must survive an extension restart. */
function record() {
  const ownerText = '\ufeff<query>SELECT 1</query>\r\n<!-- unsaved 😀 -->';
  return { schemaVersion: 1, id: randomUUID(), projectKey: "opaque project/member",
    node: { kind: "object", objectId: "opaque owner" }, source: { value: "Ext/Template.xml", encoding: "utf-8" },
    descriptor: { value: "Template.xml", encoding: "utf-8" }, descriptorSnapshot: "a".repeat(64), diskSnapshot: "b".repeat(64),
    ownerSnapshot: querySnapshot(ownerText), ownerText, ownerVersion: "9007199254740993", contextFingerprint: "c".repeat(64),
    application: "app", identity: { kind: "dataSet", path: ["Union", "Query"] },
    base: "SELECT 1", draft: "SELECT 2\nFROM T", writable: true };
}

/** Every test owns a unique sibling-playground directory; no project source is modified. */
async function directory(t) {
  const path = await mkdtemp(join(process.env.ESKA_TEST_ROOT ?? resolve("../eska-playground"), "explorer-query-recovery-"));
  t.after(() => rm(path, { recursive: true, force: true }));
  await mkdir(join(path, "private")); await mkdir(join(path, "project"));
  return join(path, "private");
}

/** A failed metadata open retains the initialized API 1.14 endpoint used by production recovery. */
async function recovery(t, path, damaged = () => assert.fail("valid record"), options = {}) {
  const connection = new Connection("recovery-test", () => {}, () => {});
  t.after(() => connection.dispose());
  const target = { executable, path: options.cwd ?? join(dirname(path), "project"), name: "recovery", locale: options.locale ?? "en-US" };
  await connection.connect(target);
  assert.equal(connection.state.kind, "error");
  assert.equal(connection.state.error.code, "manifestMissing");
  assert.ok(connection.recovery, "private storage does not require a metadata workspace");
  const endpoint = options.wrap ? options.wrap(connection.recovery) : connection.recovery;
  const store = new QueryRecovery(endpoint, path, damaged, options.previous);
  // Failed admission has no outstanding write; successful sessions must drain every acknowledgement.
  connection.beforeStop(async () => { try { await store.settled(); } catch { /* The scenario asserts its storage failure. */ } });
  return { store, connection, target };
}

/** A persistent OS lock inode is backend infrastructure, not an unfinished draft or temporary record. */
async function files(path) { return (await readdir(path)).filter(name => name !== ".eska-query-recovery.lock"); }

test("recovery retains exact dirty owner, independent draft, application and stable bindings across a cold load", integration, async t => {
  const path = await directory(t), value = record();
  const damaged = [];
  const { store } = await recovery(t, path, id => damaged.push(id));
  await store.create(value); await store.settled();
  assert.deepEqual(await (await recovery(t, path, id => damaged.push(id))).store.records(), [value]);
  assert.deepEqual(damaged, []);
  assert.deepEqual(await files(path), [value.id + ".json"]);
  const stored = JSON.parse(await readFile(join(path, value.id + ".json"), "utf8"));
  assert.equal(stored.storageVersion, 1);
  assert.equal(Buffer.from(stored.ownerText, "base64").toString("utf8"), value.ownerText);
  assert.equal(Buffer.from(stored.draft, "base64").toString("utf8"), value.draft);
});

test("rapid draft updates persist the latest revision and leave no temporary files", integration, async t => {
  const path = await directory(t), value = record();
  const { store } = await recovery(t, path);
  await store.create(value);
  await Promise.all(Array.from({ length: 100 }, (_, index) => store.save({ ...value, draft: `SELECT ${index}` })));
  await store.settled();
  const [recovered] = await (await recovery(t, path)).store.records();
  assert.equal(recovered.draft, "SELECT 99");
  assert.equal(recovered.ownerText, value.ownerText);
  assert.deepEqual(await files(path), [value.id + ".json"]);
});

test("closing a session during storage writes cannot resurrect its record or delete unrelated recovery files", integration, async t => {
  const path = await directory(t), value = record();
  await writeFile(join(path, "manual-copy.json"), "keep");
  const { store } = await recovery(t, path);
  await store.records();
  await store.create(value);
  const saving = store.save({ ...value, draft: "changed" });
  await store.remove(value.id); await saving;
  await store.settled();
  assert.deepEqual(await store.records(), []);
  assert.deepEqual(await files(path), ["manual-copy.json"]);
  assert.equal(await readFile(join(path, "manual-copy.json"), "utf8"), "keep");
  await assert.rejects(store.save(value), { code: "obsolete" });
});

test("damaged and aliased records are reported and preserved, without becoming source instructions", integration, async t => {
  const path = await directory(t), bad = record(), alias = record();
  await writeFile(join(path, bad.id + ".json"), JSON.stringify({ ...bad, ownerText: "forged" }));
  await writeFile(join(path, "manual.json"), "private copy");
  await symlink(join(path, "manual.json"), join(path, alias.id + ".json"));
  const damaged = [];
  const { store } = await recovery(t, path, id => damaged.push(id));
  assert.deepEqual(await store.records(), []);
  assert.deepEqual(damaged.sort(), [bad.id, alias.id].sort());
  assert.equal(JSON.parse(await readFile(join(path, bad.id + ".json"), "utf8")).ownerText, "forged");
  assert.equal(await readFile(join(path, "manual.json"), "utf8"), "private copy");
});

test("malformed snapshots, versions, identities and text cannot be accepted as recovered owners", () => {
  const value = record();
  for (const replacement of [{ schemaVersion: 2 }, { id: "../source.xml" }, { ownerVersion: "0" },
    { ownerVersion: 7 }, { ownerSnapshot: "f".repeat(64) }, { source: null }, { identity: { kind: "dataSet", path: [] } },
    { draft: "bad\ud800" }, { application: "" }, { projectKey: "bad\ud800" }, { projectKey: "x".repeat(1048577) }]) {
    assert.throws(() => parseDraftRecord({ ...value, ...replacement }), { code: "sourceChanged" });
  }
});

/** Optional capability negotiation never invents persistence on an older or incompatible peer. */
test("recovery capabilities require API 1.14, revision comparison and bounded staging", () => {
  const hello = { apiVersion: { major: 1, minor: 14 }, capabilities: { queryRecovery: {
    schemaVersion: 1, storageVersion: 1, writesOwner: false, compareRevision: true, ...RECOVERY_LIMITS,
  } } };
  assert.equal(recoveryCapabilities({ capabilities: {} }), undefined);
  assert.deepEqual(recoveryCapabilities(hello), RECOVERY_LIMITS);
  assert.equal(recoveryCapabilities({ ...hello, capabilities: { queryRecovery: { ...hello.capabilities.queryRecovery,
    maxChunkBytes: 262144 } } }).maxChunkBytes, 131072);
  assert.throws(() => recoveryCapabilities({ ...hello, apiVersion: { major: 1, minor: 13 } }), { code: "protocolInvalid" });
  for (const replacement of [{ writesOwner: true }, { compareRevision: false }, { storageVersion: 2 },
    { maxRecords: 0 }, { maxUploads: 2 }, { maxTextBytes: -1 }, { maxChunkBytes: 1.5 }]) {
    assert.throws(() => recoveryCapabilities({ ...hello,
      capabilities: { queryRecovery: { ...hello.capabilities.queryRecovery, ...replacement } } }), { code: "protocolInvalid" });
  }
});

test("recovery quota rejects extra sessions and oversized drafts while retaining previous records", integration, async t => {
  const path = await directory(t), { store } = await recovery(t, path);
  const values = Array.from({ length: 16 }, () => record());
  for (const value of values) await store.create(value);
  await assert.rejects(store.create(record()), { code: "resourceLimit" });
  await assert.rejects(store.save({ ...values[0], draft: "x".repeat(8388609) }), { code: "resourceLimit" });
  assert.deepEqual(await (await recovery(t, path)).store.records(),
    values.sort((a, b) => a.id.localeCompare(b.id)));
  assert.equal((await files(path)).length, 16);
});

test("a failed storage location is an explicit error and never writes into a project fallback", integration, async t => {
  const path = await directory(t), file = join(path, "not-a-directory");
  await writeFile(file, "keep");
  const { store } = await recovery(t, file, () => {}, { cwd: join(dirname(path), "project") });
  await assert.rejects(store.create(record()), error => error.details?.reason === "recovery_path");
  assert.equal(await readFile(file, "utf8"), "keep");
  await mkdir(join(path, "private"));
  assert.deepEqual(await (await recovery(t, join(path, "private"), undefined, { cwd: join(dirname(path), "project") })).store.records(), []);
});

// Three 8 MiB control-character components cross the real framed pipe in both directions.
test("full-size unfinished UTF-8 drafts survive recovery without JSON escaping exceeding the file budget", { ...integration, timeout: 30_000 }, async t => {
  const path = await directory(t), value = record();
  value.ownerText = "\0".repeat(8388608);
  value.ownerSnapshot = querySnapshot(value.ownerText);
  value.base = value.ownerText; value.draft = value.ownerText;
  const { store } = await recovery(t, path);
  await store.create(value);
  const [recovered] = await (await recovery(t, path)).store.records();
  assert.equal(recovered.ownerText, value.ownerText);
  assert.equal(recovered.base, value.base); assert.equal(recovered.draft, value.draft);
});

/** Real uploads reuse owner/base bytes, retain UTF-8 boundaries and remain below the original frame limit. */
test("recovery reuses unchanged owner/base after acknowledgement and serializes independent drafts", integration, async t => {
  const path = await directory(t), value = record(), other = record();
  value.ownerText = "x".repeat(131071) + "😀\0\r\n".repeat(25000);
  value.ownerSnapshot = querySnapshot(value.ownerText);
  const calls = [];
  let uploads = 0, maximum = 0;
  const { store } = await recovery(t, path, undefined, { wrap: endpoint => ({ ...endpoint,
    async request(method, params) {
      assert.ok(Buffer.byteLength(JSON.stringify({ jsonrpc: "2.0", id: 1, method, params })) < MAX_REQUEST);
      if (method === "query/recoveryBegin") maximum = Math.max(maximum, ++uploads);
      calls.push({ method, part: params.part });
      const result = await endpoint.request(method, params);
      if (method === "query/recoveryCommit" || method === "query/recoveryCancel") uploads--;
      return result;
    },
  }) });
  await Promise.all([store.create(value), store.create(other)]);
  const first = calls.length;
  await Promise.all(Array.from({ length: 100 }, (_, index) => store.save({ ...value, draft: `SELECT ${index}` })));
  assert.equal(maximum, 1);
  // Rust normalizes JSON key order; metadata's serialized bytes differ from the original adapter order.
  assert.deepEqual(calls.slice(first).filter(call => call.method === "query/recoveryAppend").map(call => call.part), ["metadata", "draft"]);
  const values = await (await recovery(t, path)).store.records();
  assert.equal(values.find(row => row.id === value.id).ownerText, value.ownerText);
  assert.equal(values.find(row => row.id === value.id).draft, "SELECT 99");
  assert.deepEqual(values.find(row => row.id === other.id), other);
});

/** Pause at a real pipe acknowledgement, not before scheduling the save, to test the teardown barrier. */
test("restart drains an in-flight checkpoint and old endpoints cannot address a replacement process", integration, async t => {
  const path = await directory(t), value = record();
  let entered, release, armed = false;
  const seen = new Promise(resolve => { entered = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  const { store, connection, target } = await recovery(t, path, undefined, { wrap: endpoint => ({ ...endpoint,
    async request(method, params) {
      if (armed && method === "query/recoveryAppend") { armed = false; entered(); await gate; }
      return endpoint.request(method, params);
    },
  }) });
  await store.create(value);
  const oldEndpoint = connection.recovery;
  armed = true;
  const saving = store.save({ ...value, draft: "SELECT 42\n// unsaved 😀" });
  await seen;
  let restarted = false;
  const restarting = connection.connect(target).then(() => { restarted = true; });
  try {
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(restarted, false, "replacement waits for the real checkpoint acknowledgement");
  } finally { release(); }
  await saving; await restarting;
  assert.notEqual(connection.recovery, oldEndpoint);
  await assert.rejects(oldEndpoint.request("query/recoveryOpen", { directory: { value: path, encoding: "utf-8" } }), { code: "obsolete" });
  const restored = new QueryRecovery(connection.recovery, path, () => assert.fail("valid"), store.revisions());
  assert.equal((await restored.records())[0].draft, "SELECT 42\n// unsaved 😀");
});

/** A new backend cannot silently adopt a revision overwritten or removed by another IDE window. */
test("independent windows and reconnected clients reject stale overwrite, removal and resurrection", integration, async t => {
  const path = await directory(t), value = record();
  const first = await recovery(t, path);
  await first.store.create(value);
  const expected = first.store.revisions();
  const second = await recovery(t, path);
  await second.store.records();
  await second.store.save({ ...value, draft: "SELECT second" });
  await assert.rejects(first.store.save({ ...value, draft: "SELECT stale" }), error => error.details?.reason === "recovery_conflict");
  await assert.rejects(first.store.remove(value.id), error => error.details?.reason === "recovery_conflict");
  const reconnected = await recovery(t, path, undefined, { previous: expected });
  await assert.rejects(reconnected.store.save({ ...value, draft: "SELECT stale after reconnect" }), { code: "sourceChanged" });
  assert.equal((await (await recovery(t, path)).store.records())[0].draft, "SELECT second");
  await second.store.remove(value.id);
  await assert.rejects(first.store.save(value), error => error.details?.reason === "recovery_conflict");
  await assert.rejects(second.store.save(value), { code: "obsolete" });
  assert.deepEqual(await (await recovery(t, path)).store.records(), []);
});

/** Bad receipts release the acknowledged staging slot and leave the last complete file untouched. */
test("malformed upload acknowledgements cancel staging without replacing the prior checkpoint", integration, async t => {
  const path = await directory(t), value = record();
  let corrupt = false, cancelled = 0;
  const { store } = await recovery(t, path, undefined, { wrap: endpoint => ({ ...endpoint,
    async request(method, params) {
      const result = await endpoint.request(method, params);
      if (method === "query/recoveryCancel") cancelled++;
      if (corrupt && method === "query/recoveryAppend") { corrupt = false; return { ...result, receivedBytes: 0 }; }
      return result;
    },
  }) });
  await store.create(value);
  corrupt = true;
  await assert.rejects(store.save({ ...value, draft: "SELECT rejected" }), { code: "protocolInvalid" });
  assert.equal(cancelled, 1);
  assert.deepEqual(await (await recovery(t, path)).store.records(), [value]);
  await store.save({ ...value, draft: "SELECT accepted" });
  assert.equal((await (await recovery(t, path)).store.records())[0].draft, "SELECT accepted");
});
