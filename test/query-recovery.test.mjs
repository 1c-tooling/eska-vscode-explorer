import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, readFile, writeFile, readdir, mkdir, symlink } from "node:fs/promises";
import { join, resolve } from "node:path";
import { QueryRecovery, parseDraftRecord } from "../out/query/recovery.js";
import { querySnapshot } from "../out/query/client.js";

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
  t.after(() => rm(path, { recursive: true, force: true })); return path;
}

test("recovery retains exact dirty owner, independent draft, application and stable bindings across a cold load", async t => {
  const path = await directory(t), value = record();
  const damaged = [];
  const store = new QueryRecovery(path, id => damaged.push(id));
  await store.save(value); await store.settled();
  assert.deepEqual(await new QueryRecovery(path, id => damaged.push(id)).records(), [value]);
  assert.deepEqual(damaged, []);
  assert.deepEqual(await readdir(path), [value.id + ".json"]);
  const stored = JSON.parse(await readFile(join(path, value.id + ".json"), "utf8"));
  assert.equal(stored.storageVersion, 1);
  assert.equal(Buffer.from(stored.ownerText, "base64").toString("utf8"), value.ownerText);
  assert.equal(Buffer.from(stored.draft, "base64").toString("utf8"), value.draft);
});

test("rapid draft updates persist the latest revision and leave no temporary files", async t => {
  const path = await directory(t), value = record();
  const store = new QueryRecovery(path, () => assert.fail("valid record"));
  await Promise.all(Array.from({ length: 100 }, (_, index) => store.save({ ...value, draft: `SELECT ${index}` })));
  await store.settled();
  const [recovered] = await new QueryRecovery(path, () => assert.fail("valid record")).records();
  assert.equal(recovered.draft, "SELECT 99");
  assert.equal(recovered.ownerText, value.ownerText);
  assert.deepEqual(await readdir(path), [value.id + ".json"]);
});

test("closing a session during storage writes cannot resurrect its record or delete unrelated recovery files", async t => {
  const path = await directory(t), value = record();
  await writeFile(join(path, "manual-copy.json"), "keep");
  const store = new QueryRecovery(path, () => assert.fail("valid record"));
  await store.records();
  const saving = store.save(value);
  await store.remove(value.id); await saving;
  await store.settled();
  assert.deepEqual(await store.records(), []);
  assert.deepEqual(await readdir(path), ["manual-copy.json"]);
  assert.equal(await readFile(join(path, "manual-copy.json"), "utf8"), "keep");
  await assert.rejects(store.save(value), { code: "obsolete" });
});

test("damaged and aliased records are reported and preserved, without becoming source instructions", async t => {
  const path = await directory(t), bad = record(), alias = record();
  await writeFile(join(path, bad.id + ".json"), JSON.stringify({ ...bad, ownerText: "forged" }));
  await writeFile(join(path, "manual.json"), "private copy");
  await symlink(join(path, "manual.json"), join(path, alias.id + ".json"));
  const damaged = [];
  const store = new QueryRecovery(path, id => damaged.push(id));
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

test("recovery quota rejects extra sessions and oversized drafts while retaining previous records", async t => {
  const path = await directory(t), store = new QueryRecovery(path, () => assert.fail("valid record"));
  const values = Array.from({ length: 16 }, () => record());
  for (const value of values) await store.save(value);
  await assert.rejects(store.save(record()), { code: "resourceLimit" });
  await assert.rejects(store.save({ ...values[0], draft: "x".repeat(8388609) }), { code: "resourceLimit" });
  assert.deepEqual(await new QueryRecovery(path, () => assert.fail("valid record")).records(),
    values.sort((a, b) => a.id.localeCompare(b.id)));
  assert.equal((await readdir(path)).length, 16);
});

test("a failed storage location is an explicit error and never writes into a project fallback", async t => {
  const path = await directory(t), file = join(path, "not-a-directory");
  await writeFile(file, "keep");
  const store = new QueryRecovery(file, () => {});
  await assert.rejects(store.save(record()), { code: "ENOTDIR" });
  assert.equal(await readFile(file, "utf8"), "keep");
  await mkdir(join(path, "private"));
  assert.deepEqual(await new QueryRecovery(join(path, "private"), () => assert.fail("empty")).records(), []);
});

test("full-size unfinished UTF-8 drafts survive recovery without JSON escaping exceeding the file budget", async t => {
  const path = await directory(t), value = record();
  value.ownerText = "\0".repeat(8388608);
  value.ownerSnapshot = querySnapshot(value.ownerText);
  value.base = value.ownerText; value.draft = value.ownerText;
  const store = new QueryRecovery(path, () => assert.fail("bounded valid recovery data"));
  await store.save(value);
  const [recovered] = await new QueryRecovery(path, () => assert.fail("bounded valid recovery data")).records();
  assert.equal(recovered.ownerText, value.ownerText);
  assert.equal(recovered.base, value.base); assert.equal(recovered.draft, value.draft);
});
