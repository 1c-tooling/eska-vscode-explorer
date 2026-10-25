import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { join, resolve, relative } from "node:path";
import { Connection } from "../out/connection.js";
import { MetadataTree } from "../out/tree.js";
import { revealFile } from "../out/reveal.js";
import { QueryClient, querySnapshot } from "../out/query/client.js";
import { QueryRecovery } from "../out/query/recovery.js";
import { QuerySessions } from "../out/query/sessions.js";
import { QueryLanguageProjection, projectionCapabilities } from "../out/query/projections.js";
import { createTreeProject } from "./fixture.mjs";
import { createQuerySource } from "./query-fixture.mjs";

const executable = process.env.ESKA_TEST_BINARY;
const limits = { maxBytes: 8_388_608, maxChunk: 131_072, maxPositions: 64, maxEdits: 64 };

/** No LSP or editor service participates in transport and resource-limit negotiation. */
test("projection contract is immutable, explicit and bounded", () => {
  const capability = { schemaVersion: 1, writesOwner: false, writesDraft: false, sharedQueryBudget: true, sourceKinds: ["bsl"],
    maxSnapshotBytes: 8_388_608, maxChunkBytes: 131_072, maxPositions: 64, maxEdits: 64 };
  const hello = { apiVersion: { major: 1, minor: 20 }, capabilities: { queryProjections: capability } };
  assert.deepEqual(projectionCapabilities(hello), limits);
  assert.equal(projectionCapabilities({ capabilities: {} }), undefined);
  for (const changed of [{ writesOwner: true }, { writesDraft: true }, { sourceKinds: ["bsl", "form"] }, { maxPositions: 0 }]) {
    assert.throws(() => projectionCapabilities({ ...hello, capabilities: { queryProjections: { ...capability, ...changed } } }), { code: "protocolInvalid" });
  }
  assert.throws(() => projectionCapabilities({ ...hello, apiVersion: { major: 1, minor: 19 } }), { code: "protocolInvalid" });
});

/** Faults are injected only in byte replies; even malformed acknowledgements must free their allocated handle. */
test("projection reader validates hashes and releases allocation after malformed body", async () => {
  const draft = "SELECT 1", owner = { version: "7", snapshot: querySnapshot("owner") };
  const source = { value: "Ext/Module.bsl", encoding: "utf-8" };
  const raw = { projectionId: "l1", snapshot: querySnapshot("exact"), revision: "2", source, sourceKind: "bsl", readOnly: true,
    nativeVersion: owner.version, nativeSnapshot: owner.snapshot, bytes: 5, draftBytes: Buffer.byteLength(draft), draftSnapshot: querySnapshot(draft) };
  const calls = [];
  const transport = async (method, params) => {
    calls.push([method, params]);
    if (method === "query/projectionClose") return { released: true };
    return { projectionId: "l1", snapshot: raw.snapshot, offset: 0, nextOffset: 5, eof: true, data: Buffer.from("wrong").toString("base64") };
  };
  await assert.rejects(QueryLanguageProjection.capture(transport, raw, limits, { owner, source, draft, revision: "2" }), { code: "protocolInvalid" });
  assert.equal(calls.at(-1)[0], "query/projectionClose");
  assert.equal(calls.at(-1)[1].projectionId, "l1");
});

/** A real metadata process and checkpoint store verify projection behavior without importing VS Code. */
async function fixture(t, locale) {
  const outer = await mkdtemp(join(process.env.ESKA_TEST_ROOT ?? resolve("../eska-playground"), "explorer-query-projection-"));
  const connection = new Connection("projection-test", () => {}, () => {});
  let tree, store;
  t.after(async () => { await store?.settled().catch(() => {}); tree?.dispose(); await connection.dispose(); await rm(outer, { recursive: true, force: true }); });
  const files = await createTreeProject(join(outer, "project")); await createQuerySource(files);
  const owner = "// 😀\r\nQ = \"SELECT 1\";\r\nTail = 42;\r\n";
  await writeFile(files.module, owner.replace("42", "41"));
  const disk = await readFile(files.module);
  await connection.connect({ executable, path: files.root, name: "projection", locale });
  const state = connection.state; assert.equal(state.kind, "ready", JSON.stringify(state));
  assert.ok(connection.recovery.sessions.capabilities.projections);
  tree = new MetadataTree(connection, state.session, () => {}, () => {});
  const project = tree.projects[0], entry = await revealFile(tree, files.module);
  assert.equal(entry.node.id.kind, "module");
  store = new QueryRecovery(connection.recovery, join(outer, "private"), () => assert.fail("valid record")); await store.records();
  const context = () => ({ sessionId: state.session.sessionId, projectId: project.info.projectId, generation: project.info.generation });
  const source = { value: relative(files.source, files.module), encoding: "utf-8" };
  const document = await new QueryClient(connection, state.session.sessionId, project, state.queryEditing).open({ node: entry.node.id, source, version: "7", text: owner });
  const query = await document.read({ at: { line: 1, character: 9 } });
  const session = await new QuerySessions(connection.recovery, store, context, state.queryEditing).open(document, randomUUID(), query.identity, false);
  await document.close();
  return { files, disk, owner, store, session, facts: { version: "7", snapshot: querySnapshot(owner), isDirty: true, userReadOnly: false, application: null } };
}

for (const locale of ["en-US", "ru-RU"]) test(`projection SDK maps actual dirty BSL without source or checkpoint writes (${locale})`, { skip: !executable }, async t => {
  const value = await fixture(t, locale), draft = "SELECT Т.Ар\nFROM Catalog.Товары AS Т";
  await value.store.saveDraft(value.session.header.id, draft);
  const view = await value.session.projection(value.facts);
  t.after(() => view.close().catch(() => {}));
  assert.equal(view.draft, draft);
  assert.ok(view.ownerText.includes('Q = "SELECT Т.Ар'));
  assert.ok(view.ownerText.endsWith("Tail = 42;\r\n"));
  const points = await view.map("draftToOwner", [{ line: 0, character: 11 }]);
  assert.deepEqual(points, [{ target: "owner", position: { line: 1, character: 16 } }]);
  const back = await view.map("ownerToDraft", [points[0].position]);
  assert.deepEqual(back, [{ target: "draft", position: { line: 0, character: 11 } }]);
  const plan = await view.edits([{ range: { start: { line: 1, character: 14 }, end: { line: 1, character: 16 } }, newText: "Артикул" }]);
  assert.equal(plan.replacements[0].text, "тикул");
  assert.equal(plan.outputSnapshot, querySnapshot(draft.replace("Ар", "Артикул")));
  assert.equal(value.session.record.draft, draft);
  assert.equal(value.session.header.applyPending, false);
  await assert.rejects(value.session.projection({ ...value.facts, version: "8" }), { domain: "query_failed" });
  await value.session.close();
  assert.deepEqual(await readFile(value.files.module), value.disk);
  await view.close();
  await assert.rejects(view.map("ownerToDraft", []), { code: "obsolete" });
});
