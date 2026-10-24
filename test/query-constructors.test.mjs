import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { resolve, join, relative } from "node:path";
import { Connection } from "../out/connection.js";
import { MetadataTree } from "../out/tree.js";
import { revealFile } from "../out/reveal.js";
import { QueryClient, querySnapshot } from "../out/query/client.js";
import { QueryRecovery } from "../out/query/recovery.js";
import { QuerySessions } from "../out/query/sessions.js";
import { CLAUSES, QueryConstructor, constructorCapabilities } from "../out/query/constructors.js";
import { querySessionCapabilities } from "../out/query/session-protocol.js";
import { createTreeProject } from "./fixture.mjs";

const executable = process.env.ESKA_TEST_BINARY, limits = { maxExpression: 16384, maxModel: 33554432 };
const capability = { schemaVersion: 1, writesOwner: false, writesDraft: true, explicitFinish: true, exclusiveDraft: true,
  lossless: true, nativeDraftPlan: true, sourceCommentPositions: true, sharedQueryBudget: true, maxExpressionBytes: 16384, maxModelBytes: 33554432, clauses: [...CLAUSES] };

/** Structured operations and metadata choices require an explicit coherent capability, never a guessed crate version. */
test("visual constructor capabilities are additive and require Metadata API 1.22", () => {
  const visual = { ...capability, visualExpressions: true, metadataCatalog: true };
  assert.deepEqual(constructorCapabilities({ apiVersion: { major: 1, minor: 22 }, capabilities: { queryConstructor: visual } }), { ...limits, visual: true });
  for (const [minor, change] of [[21, {}], [22, { metadataCatalog: false }], [22, { visualExpressions: false }]]) {
    assert.throws(() => constructorCapabilities({ apiVersion: { major: 1, minor }, capabilities: { queryConstructor: { ...visual, ...change } } }), { code: "protocolInvalid" });
  }
});

/** Version and explicit ownership semantics are required independently from language projections. */
test("constructor capability requires an exclusive lossless native-draft plan contract", () => {
  const hello = { apiVersion: { major: 1, minor: 21 }, capabilities: { queryConstructor: capability } };
  assert.deepEqual(constructorCapabilities(hello), limits);
  assert.equal(constructorCapabilities({ capabilities: {} }), undefined);
  for (const change of [{ exclusiveDraft: false }, { writesOwner: true }, { nativeDraftPlan: false }, { clauses: ["fields"] }, { maxExpressionBytes: 0 }]) {
    assert.throws(() => constructorCapabilities({ ...hello, capabilities: { queryConstructor: { ...capability, ...change } } }), { code: "protocolInvalid" });
  }
  const legacy = querySessionCapabilities({ apiVersion: { major: 1, minor: 20 }, capabilities: { querySessions: { schemaVersion: 1, writesOwner: false,
    checkpointStorageVersion: 1, preparedStorageVersion: 2, preparedStateDurable: true, nativeApplicationReceipt: true, explicitResume: true,
    bslEditing: false, sourceKinds: ["dataCompositionSchema", "form"], maxSessions: 16, maxRetainedBytes: 33554432 } } });
  assert.equal(legacy.constructorLimits, undefined, "no Object.prototype.constructor fallback");
});

/** Malformed body data cannot strand the core lock acquired by the preceding request. */
test("constructor capture releases its allocated token after an invalid model", async () => {
  const calls = [], text = "SELECT 1";
  await assert.rejects(QueryConstructor.capture(async (method, params) => { calls.push({ method, params }); return { released: true }; },
    { id: "7", revision: "1", snapshot: querySnapshot("wrong"), text, bytes: Buffer.byteLength(text), writable: true, statements: [] }, text, limits), { code: "protocolInvalid" });
  assert.deepEqual(calls, [{ method: "query/constructorCancel", params: { constructorId: "7" } }]);
});

/** The real standalone protocol and shared recovery queue own both constructor state and canonical draft publication. */
async function fixture(t, locale, readonly = false) {
  const outer = await mkdtemp(join(process.env.ESKA_TEST_ROOT ?? resolve("../eska-playground"), "explorer-query-constructor-"));
  const connection = new Connection("constructor-test", () => {}, () => {}); let tree, store;
  t.after(async () => { await store?.settled().catch(() => {}); tree?.dispose(); await connection.dispose(); await rm(outer, { recursive: true, force: true }); });
  const files = await createTreeProject(join(outer, "project"));
  await mkdir(join(files.source, "Ext")); await writeFile(join(files.source, "Ext", "ParentConfigurations.bin"), "{6,0,0,0,0,0}");
  const owner = '// 😀\r\nQ = "SELECT A, B FROM T";\r\nTail = 42;\r\n'; await writeFile(files.module, owner);
  await connection.connect({ executable, path: files.root, name: "constructor", locale });
  const state = connection.state; assert.equal(state.kind, "ready", JSON.stringify(state));
  const send = connection.child.request.bind(connection.child);
  connection.child.request = async (method, ...args) => {
    try { return await send(method, ...args); }
    catch (error) { error.message += ` ${method} ${JSON.stringify(error.details)}`; throw error; }
  };

  const constructor = connection.recovery.sessions.capabilities.constructorLimits;
  assert.deepEqual({ maxExpression: constructor.maxExpression, maxModel: constructor.maxModel }, limits);
  tree = new MetadataTree(connection, state.session, () => {}, () => {});
  const project = tree.projects[0], entry = await revealFile(tree, files.module);
  store = new QueryRecovery(connection.recovery, join(outer, "private"), () => assert.fail("valid checkpoint")); await store.records();
  const document = await new QueryClient(connection, state.session.sessionId, project, state.queryEditing).open({ node: entry.node.id,
    source: { value: relative(files.source, files.module), encoding: "utf-8" }, version: "7", text: owner });
  const query = await document.read({ at: { line: 1, character: 8 } });
  const sessions = new QuerySessions(connection.recovery, store, () => ({ sessionId: state.session.sessionId, projectId: project.info.projectId, generation: project.info.generation }), state.queryEditing);
  const source = await sessions.open(document, randomUUID(), query.identity, readonly);
  assert.equal(source.header.protection.capturedSourceWritable, true, "fixture has a known writable support policy");
  return { files, owner, source, store, connection };
}

/** Apply only a checked draft plan, leaving its XML/BSL owner untouched. */
function apply(text, plan) {
  const bytes = Buffer.from(text), parts = []; let end = 0;
  for (const replacement of plan.replacements) { parts.push(bytes.subarray(end, replacement.range.start), Buffer.from(replacement.text)); end = replacement.range.end; }
  parts.push(bytes.subarray(end)); const value = Buffer.concat(parts).toString(); assert.equal(querySnapshot(value), plan.outputSnapshot); return value;
}

for (const locale of ["ru-RU", "en-US"]) {
  test(`large constructor expressions remain inspectable without malformed structured DTOs (${locale})`, { skip: !executable }, async t => {
    const f = await fixture(t, locale), text = `SELECT ${"A".repeat(16385)} FROM T`;
    await f.store.saveDraft(f.source.record.id, text);
    const constructor = await f.source.openConstructor();
    const item = constructor.model.statements[0].clauses[0].items[0];
    assert.equal(item.expression, null); assert.equal(item.visual, null); assert.equal(item.unavailable.replace, "expression_too_large");
    await constructor.cancel(); assert.equal(f.source.record.draft, text);
  });
  test(`real visual metadata selection uses core-qualified fields and keeps source/checkpoint unchanged (${locale})`, { skip: !executable }, async t => {
    const f = await fixture(t, locale), original = f.source.record.draft, disk = await readFile(f.files.module);
    const constructor = await f.source.openConstructor(); assert.equal(constructor.limits.visual, true);
    const methods = [], request = f.connection.child.request.bind(f.connection.child);
    f.connection.child.request = (method, ...args) => { methods.push(method); return request(method, ...args); };
    const page = await constructor.catalog({ search: "Товары" }); assert.equal(page.tables.length, 1);
    assert.deepEqual(methods, ["query/constructorCatalog"], "metadata inspection never reloads private draft parts");
    const table = page.tables[0]; assert.equal(table.english, "Catalog.Товары");
    const metadata = await constructor.catalog({ table: table.english, qualifier: "Товары" });
    assert.ok(metadata.found); assert.ok(metadata.fields.some(field => field.english === "Товары.Артикул"));
    assert.ok(metadata.tables.some(table => table.english === "Catalog.Товары.Строки"));
    await constructor.action({ kind: "compose", statement: 0, selection: null, expression: { kind: "source", table: table.english, alias: "" } });
    assert.ok(constructor.model.statements[0].sources.some(source => source.alias === "Товары"));
    await constructor.action({ kind: "appendFields", statement: 0, fields: ["Товары.Артикул", "Товары.Ref", "Товары.Ref"] });
    assert.equal(constructor.model.text.match(/Товары\.Ref/g).length, 1);
    assert.equal(f.source.record.draft, original); assert.deepEqual(await readFile(f.files.module), disk);
    await constructor.cancel(); assert.equal(f.source.record.draft, original);
  });
  test(`real constructor plans, cancels and explicitly publishes the same BSL draft (${locale})`, { skip: !executable }, async t => {
    const f = await fixture(t, locale), before = f.source.record.draft;
    let constructor = await f.source.openConstructor();
    assert.equal(f.source.header.constructorActive, true); assert.equal(f.source.header.draftWritable, false);
    await constructor.action({ kind: "move", selection: { statement: 0, clause: 0, item: 1 }, to: 0 });
    assert.equal(f.store.record(f.source.header.id).draft, before);
    assert.equal(constructor.model.text, "SELECT B, A FROM T");
    await constructor.cancel(); assert.equal(f.source.header.constructorActive, false); assert.equal(f.source.record.draft, before);
    constructor = await f.source.openConstructor();
    await constructor.action({ kind: "append", statement: 0, clause: "conditions", text: "A = &Parameter" });
    const plan = await constructor.plan(querySnapshot(before));
    assert.equal(f.source.record.draft, before, "planning holds canonical state unchanged");
    const actual = apply(before, plan);
    await constructor.finish(querySnapshot(before), querySnapshot(actual));
    assert.equal(f.source.record.draft, actual); assert.equal(f.source.header.applyPending, false); assert.equal(f.source.header.draftWritable, true);
    assert.equal(await readFile(f.files.module, "utf8"), f.owner);
    const comments = await f.source.comments([{ line: 0, character: 0 }, { line: 1, character: 0 }]);
    assert.equal(comments.lineStartsOnly, true); assert.equal(comments.positions[0].queryOffset, null);
    assert.equal(comments.positions[1].queryOffset, before.length + 1);
    await constructor.cancel(); assert.equal(f.source.record.draft, actual);
    await f.source.close();
  });
}

test("real read-only constructor exposes its lossless model without permitting an action", { skip: !executable }, async t => {
  const f = await fixture(t, "en-US", true), before = f.source.record.draft;
  const constructor = await f.source.openConstructor(); assert.equal(constructor.model.writable, false);
  await assert.rejects(constructor.action({ kind: "append", statement: 0, clause: "fields", text: "2" }), error => error.details?.reason === "user_read_only");
  const plan = await constructor.plan(querySnapshot(before)); assert.equal(plan.noOp, true);
  await constructor.finish(querySnapshot(before)); assert.equal(f.source.record.draft, before);
  assert.equal(await readFile(f.files.module, "utf8"), f.owner);
});
