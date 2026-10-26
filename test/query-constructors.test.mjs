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
import { BASE_CLAUSES as CLAUSES, CLAUSES as ADVANCED_CLAUSES, PACKAGE_CLAUSES, HAVING_CLAUSES, QueryConstructor, constructorCapabilities, constructorModel } from "../out/query/constructors.js";
import { querySessionCapabilities } from "../out/query/session-protocol.js";
import { createTreeProject } from "./fixture.mjs";
import { addQueryRegister } from "./query-advanced-fixture.mjs";

const executable = process.env.ESKA_TEST_BINARY, limits = { maxExpression: 16384, maxModel: 33554432 };
const capability = { schemaVersion: 1, writesOwner: false, writesDraft: true, explicitFinish: true, exclusiveDraft: true,
  lossless: true, nativeDraftPlan: true, sourceCommentPositions: true, sharedQueryBudget: true, maxExpressionBytes: 16384, maxModelBytes: 33554432, clauses: [...CLAUSES] };

/** Current discovery must match the native dialect and its explicit resource limit. */
test("native totals require minor 30 and the explicit single-section limit", () => {
  const value = { ...capability, visualExpressions: true, metadataCatalog: true, virtualTables: true, nestedQueries: true, unions: true, totals: true,
    packages: true, temporaryTables: true, having: true, totalSections: true, maxTotalSections: 1, dcs: true, maxDcsValues: 128, clauses: [...HAVING_CLAUSES] };
  const hello = { apiVersion: { major: 1, minor: 30 }, capabilities: { queryConstructor: value } };
  assert.equal(constructorCapabilities(hello).maxTotalSections, 1);
  for (const change of [{ maxTotalSections: 32 }, { multipleTotals: true }, { totalSections: false }]) {
    assert.throws(() => constructorCapabilities({ ...hello, capabilities: { queryConstructor: { ...value, ...change } } }), { code: "protocolInvalid" });
  }
});

/** DCS editing needs its complete explicit capability, including the legacy section DTO. */
test("DCS constructor requires minor 29 and bounded typed value lists", () => {
  const value = { ...capability, visualExpressions: true, metadataCatalog: true, virtualTables: true, nestedQueries: true, unions: true, totals: true,
    packages: true, temporaryTables: true, having: true, multipleTotals: true, maxTotalSections: 32, dcs: true, maxDcsValues: 128, clauses: [...HAVING_CLAUSES] };
  assert.equal(constructorCapabilities({ apiVersion: { major: 1, minor: 29 }, capabilities: { queryConstructor: value } }).dcs, true);
  for (const [minor, change] of [[28, {}], [29, { multipleTotals: undefined }], [29, { maxDcsValues: 0 }]]) {
    assert.throws(() => constructorCapabilities({ apiVersion: { major: 1, minor }, capabilities: { queryConstructor: { ...value, ...change } } }), { code: "protocolInvalid" });
  }
});

/** Package/table shape additions are accepted only as a complete explicit minor-26 capability. */
test("package constructor capabilities require coherent negotiation and clause vocabulary", () => {
  const value = { ...capability, visualExpressions: true, metadataCatalog: true, virtualTables: true, nestedQueries: true, unions: true, totals: true,
    packages: true, temporaryTables: true, clauses: [...PACKAGE_CLAUSES] };
  assert.equal(constructorCapabilities({ apiVersion: { major: 1, minor: 26 }, capabilities: { queryConstructor: value } }).packages, true);
  for (const [minor, change] of [[25, {}], [26, { temporaryTables: false }], [26, { unions: undefined }], [26, { clauses: [...ADVANCED_CLAUSES] }]]) {
    assert.throws(() => constructorCapabilities({ apiVersion: { major: 1, minor }, capabilities: { queryConstructor: { ...value, ...change } } }), { code: "protocolInvalid" });
  }
});

/** Aggregate filters need their own negotiated clause and cannot be mistaken for ordinary WHERE. */
test("HAVING capabilities require minor 27 and the complete package vocabulary", () => {
  const value = { ...capability, visualExpressions: true, metadataCatalog: true, virtualTables: true, nestedQueries: true, unions: true, totals: true,
    packages: true, temporaryTables: true, having: true, clauses: [...HAVING_CLAUSES] };
  assert.equal(constructorCapabilities({ apiVersion: { major: 1, minor: 27 }, capabilities: { queryConstructor: value } }).having, true);
  for (const [minor, change] of [[26, {}], [27, { packages: undefined, temporaryTables: undefined }], [27, { having: false }]]) {
    assert.throws(() => constructorCapabilities({ apiVersion: { major: 1, minor }, capabilities: { queryConstructor: { ...value, ...change } } }), { code: "protocolInvalid" });
  }
});

/** Sequential totals are opt-in even when a client already supports one totals section. */
test("multiple totals require explicit minor 28 and the section bound", () => {
  const value = { ...capability, visualExpressions: true, metadataCatalog: true, virtualTables: true, nestedQueries: true, unions: true, totals: true,
    packages: true, temporaryTables: true, having: true, multipleTotals: true, maxTotalSections: 32, clauses: [...HAVING_CLAUSES] };
  assert.equal(constructorCapabilities({ apiVersion: { major: 1, minor: 28 }, capabilities: { queryConstructor: value } }).totalSections, true);
  for (const [minor, change] of [[27, {}], [28, { having: undefined }], [28, { maxTotalSections: 0 }]]) {
    assert.throws(() => constructorCapabilities({ apiVersion: { major: 1, minor }, capabilities: { queryConstructor: { ...value, ...change } } }), { code: "protocolInvalid" });
  }
});

/** New clause identifiers and domain intentions require explicit minor-23 negotiation with visual support. */
test("advanced constructor capabilities reject partial or older negotiation", () => {
  const features = { visual: true, virtualTables: true, nestedQueries: true, unions: true, totals: true };
  const advanced = { ...capability, ...features, visualExpressions: true, metadataCatalog: true, clauses: [...ADVANCED_CLAUSES] };
  assert.deepEqual(constructorCapabilities({ apiVersion: { major: 1, minor: 23 }, capabilities: { queryConstructor: advanced } }), { ...limits, ...features });
  for (const [minor, change] of [[22, {}], [23, { totals: false }], [23, { clauses: [...CLAUSES] }], [23, { metadataCatalog: false }]]) {
    assert.throws(() => constructorCapabilities({ apiVersion: { major: 1, minor }, capabilities: { queryConstructor: { ...advanced, ...change } } }), { code: "protocolInvalid" });
  }
});

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

/** Atomic batches require a coherent explicit capability even on a newer server. */
test("bulk constructor operations require minor 31 and complete capabilities", () => {
  const value = {...capability, visualExpressions:true,metadataCatalog:true,bulkItems:true,addSourceFields:true,maxBulkItems:512};
  assert.equal(constructorCapabilities({apiVersion:{major:1,minor:31},capabilities:{queryConstructor:value}}).bulkItems,true);
  for(const [minor,change] of [[30,{}],[31,{addSourceFields:undefined}],[31,{maxBulkItems:513}],[31,{bulkItems:false}]])
    assert.throws(()=>constructorCapabilities({apiVersion:{major:1,minor},capabilities:{queryConstructor:{...value,...change}}}),{code:'protocolInvalid'});
});

/** The real standalone protocol and shared recovery queue own both constructor state and canonical draft publication. */
async function fixture(t, locale, readonly = false) {
  const outer = await mkdtemp(join(process.env.ESKA_TEST_ROOT ?? resolve("../eska-playground"), "explorer-query-constructor-"));
  const connection = new Connection("constructor-test", () => {}, () => {}); let tree, store;
  t.after(async () => { await store?.settled().catch(() => {}); tree?.dispose(); await connection.dispose(); await rm(outer, { recursive: true, force: true }); });
  const files = await createTreeProject(join(outer, "project"));
  await addQueryRegister(files);
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
  test(`portable DCS edits retain typed slots and canonical owner bytes (${locale})`, { skip: !executable }, async t => {
    const f = await fixture(t, locale), original = "SELECT T.Ref AS Item {SELECT Item.*} FROM Catalog.Items AS T LEFT JOIN InformationRegister.Prices.SliceLast({&Period}, {Item.*}) AS P ON T.Ref = P.Item";
    await f.store.saveDraft(f.source.record.id, original);
    const core = await f.source.openConstructor(); assert.equal(core.limits.dcs, true);
    const parameter = core.model.statements[0].dcs.nodes.find(node => node.kind === "parameter");
    assert.ok(parameter.editable); assert.equal(parameter.enabled, true);
    await core.action({ kind: "setDcs", statement: 0, node: parameter.index, target: "parameter", values: [{ kind: "parameter", name: "Updated" }], enabled: true });
    assert.equal(core.model.text, original.replace("{&Period}", "{&Updated}"));
    const source = core.model.statements[0].dcs.nodes.find(node => node.kind === "optionalSource");
    await core.action({ kind: "setDcs", statement: 0, node: source.index, target: "optionalSource", values: [], enabled: true });
    assert.ok(core.model.text.includes("{LEFT JOIN"));
    await core.action({ kind: "setDcs", statement: 0, node: null, target: "where", values: [{ kind: "condition", left: "T.Ref", comparison: "equal", right: "&Item" }], enabled: true });
    assert.ok(core.model.text.includes("P.Item}\n{WHERE T.Ref = &Item}"));
    const malformed = structuredClone(core.model); malformed.statements[0].dcs.nodes[0].range.end = core.model.bytes + 1;
    assert.throws(() => constructorModel(malformed, core.limits), { code: "protocolInvalid" });
    assert.equal(f.source.record.draft, original); assert.equal(await readFile(f.files.module, "utf8"), f.owner);
    await core.cancel(); assert.equal(f.source.record.draft, original);
  });
  test(`portable read-only DCS never exposes write permissions (${locale})`, { skip: !executable }, async t => {
    const f = await fixture(t, locale, true), core = await f.source.openConstructor();
    assert.equal(core.model.statements[0].dcs.addSelect, false); assert.equal(core.model.statements[0].dcs.addWhere, false);
    assert.ok(core.model.statements[0].dcs.nodes.every(node => !node.editable));
    await assert.rejects(core.action({ kind: "setDcs", statement: 0, node: null, target: "select", values: [{ kind: "field", expression: "A", children: true, alias: "" }], enabled: true }));
    await core.cancel();
  });
  test(`portable totals use one executable section with several grouping levels (${locale})`, { skip: !executable }, async t => {
    const f = await fixture(t, locale), original = "SELECT 1 AS A, 2 AS B";
    await f.store.saveDraft(f.source.record.id, original);
    const core = await f.source.openConstructor(); assert.equal(core.limits.totalSections, true); assert.equal(core.limits.maxTotalSections, 1);
    await core.action({ kind: "addTotals", statement: 0, after: null });
    assert.equal(core.model.statements[0].addTotals, false);
    await core.action({ kind: "composeTotal", statement: 0, section: 0, selection: null, expression: { kind: "totalField", expression: "A", alias: "", aggregate: "sum" } });
    for (const name of ["A", "B"]) await core.action({ kind: "composeTotal", statement: 0, section: 0, selection: null, expression: { kind: "totalGroup", expression: name, alias: "", hierarchy: "none", period: null } });
    assert.equal(core.model.statements[0].totalSections.length, 1);
    const before = structuredClone(core.model);
    await assert.rejects(core.action({ kind: "addTotals", statement: 0, after: 0 }), error => error.details?.reason === "constructor_unsupported");
    assert.deepEqual(core.model, before);
    const malformed = structuredClone(core.model); malformed.statements[0].totalSections[0].groups = 0;
    assert.throws(() => constructorModel(malformed, core.limits), { code: "protocolInvalid" });
    const exceeded = structuredClone(core.model); exceeded.statements[0].totalSections.push(structuredClone(exceeded.statements[0].totalSections[0]));
    assert.throws(() => constructorModel(exceeded, core.limits), { code: "protocolInvalid" });
    await core.action({ kind: "removeTotals", statement: 0, section: 0 });
    assert.equal(core.model.statements[0].totalSections.length, 0);
    assert.equal(f.source.record.draft, original);
    await core.cancel(); assert.equal(f.source.record.draft, original);
  });
  test(`portable aggregate filters stay typed and private (${locale})`, { skip: !executable }, async t => {
    const f = await fixture(t, locale), original = "SELECT SUM(1) AS Total";
    await f.store.saveDraft(f.source.record.id, original);
    const core = await f.source.openConstructor(); assert.equal(core.limits.having, true);
    await core.action({ kind: "compose", statement: 0, selection: null, expression: { kind: "having", left: "SUM(1)", comparison: "greater", right: "0" } });
    const clause = core.model.statements[0].clauses.find(clause => clause.kind === "having");
    assert.equal(clause.items[0].visual.kind, "having");
    assert.ok(core.model.text.includes("HAVING SUM(1) > 0"));
    const before = structuredClone(core.model);
    await assert.rejects(core.action({ kind: "compose", statement: 0, selection: null, expression: { kind: "having", left: "1", comparison: "equal", right: "0; SELECT 9" } }), error => error.details?.reason === "constructor_invalid_expression");
    assert.deepEqual(core.model, before);
    assert.equal(f.source.record.draft, original);
    await core.cancel(); assert.equal(f.source.record.draft, original);
  });
  test(`portable package model resolves, renames and guards temporary tables (${locale})`, { skip: !executable }, async t => {
    const f = await fixture(t, locale), disk = await readFile(f.files.module), original = "SELECT 1 AS Value";
    await f.store.saveDraft(f.source.record.id, original);
    const core = await f.source.openConstructor(); assert.equal(core.limits.packages, true);
    await core.action({ kind: "setInto", statement: 0, name: "Temp" });
    await core.action({ kind: "append", statement: 0, clause: "index", text: "Value" });
    await core.action({ kind: "addStatement", statement: 0, operation: "select", name: null });
    assert.equal(core.model.focus, 1);
    const page = await core.catalog({ atStatement: 1 }); assert.equal(page.temporaryTables[0].name, "Temp");
    await core.action({ kind: "compose", statement: 1, selection: null, expression: { kind: "source", table: "Temp", alias: "T" } });
    await core.action({ kind: "compose", statement: 1, selection: { statement: 1, clause: 0, item: 0 }, expression: { kind: "field", expression: "T.Value", alias: "Value", aggregate: null } });
    const source = core.model.statements[1].sources[0];
    const fields = await core.catalog({ source: { statement: 1, clause: source.clause, item: source.item }, qualifier: "T" });
    assert.deepEqual(fields.fields, [{ russian: "T.Value", english: "T.Value" }]);
    await core.action({ kind: "setInto", statement: 0, name: "Renamed" });
    assert.ok(core.model.text.includes("FROM Renamed AS T"));
    const before = structuredClone(core.model);
    await assert.rejects(core.action({ kind: "removeStatement", statement: 0 }), error => error.details?.reason === "constructor_invalid_expression");
    assert.deepEqual(core.model, before);
    await core.action({ kind: "addStatement", statement: 1, operation: "destroy", name: "Renamed" });
    assert.equal(core.model.statements[2].package.operation, "destroy");
    assert.deepEqual(core.model.issues, []);
    assert.equal(f.source.record.draft, original); assert.deepEqual(await readFile(f.files.module), disk);
    await core.cancel(); assert.equal(f.source.record.draft, original);
  });
  test(`portable advanced constructor owns virtual arguments, nested projections, union columns and totals (${locale})`, { skip: !executable }, async t => {
    const f = await fixture(t, locale), before = f.source.record.draft, disk = await readFile(f.files.module);
    const core = await f.source.openConstructor();
    for (const key of ["virtualTables", "nestedQueries", "unions", "totals"]) assert.equal(core.limits[key], true);
    const page = await core.catalog({ table: "AccumulationRegister.Stock", virtualTables: true });
    assert.ok(page.tables.some(table => table.virtualTable === "balanceAndTurnovers"));
    const signature = await core.catalog({ table: "AccumulationRegister.Stock.BalanceAndTurnovers", virtualTables: true });
    assert.deepEqual(signature.parameters.map(parameter => parameter.key), ["beginPeriod", "endPeriod", "periodicity", "complementMethod", "condition"]);
    assert.ok(signature.parameters[2].choices.some(choice => choice.english === "MONTH"));
    await core.action({ kind: "compose", statement: 0, selection: null, expression: { kind: "virtualSource", table: "AccumulationRegister.Stock.BalanceAndTurnovers", alias: "S", parameters: ["", "&End", "Month", "RegisterRecords", "Item = &Item"] } });
    assert.ok(core.model.text.includes("BalanceAndTurnovers(, &End, Month, RegisterRecords, Item = &Item) AS S"));
    const virtual = core.model.statements[0].sources.find(source => source.alias === "S");
    const virtualFields = await core.catalog({ source: { statement: 0, clause: virtual.clause, item: virtual.item }, qualifier: "S" });
    assert.ok(virtualFields.fields.some(field => field.english === "S.QuantityClosingBalance"));
    await core.action({ kind: "compose", statement: 0, selection: null, expression: { kind: "subquerySource", alias: "Q" } });
    const source = core.model.statements[0].sources.find(source => source.derived);
    assert.equal(source.nestedScope, 1);
    const fields = await core.catalog({ source: { statement: 0, clause: source.clause, item: source.item }, qualifier: "Q" });
    assert.ok(fields.fields.some(field => field.english === "Q.Value"));
    await core.action({ kind: "compose", statement: 0, selection: null, expression: { kind: "field", expression: "Q.Value", alias: "Value", aggregate: null } });
    await core.action({ kind: "replace", selection: { statement: 1, clause: 0, item: 0 }, text: "1 AS Updated" });
    assert.ok(core.model.text.includes("Q.Updated AS Value"));
    await core.action({ kind: "addUnion", statement: 0, all: true });
    assert.equal(core.model.scopes[0].branches.length, 2);
    const tail = core.model.scopes[0].result;
    await core.action({ kind: "compose", statement: tail, selection: null, expression: { kind: "totalField", expression: "Value", alias: "", aggregate: "sum" } });
    await core.action({ kind: "compose", statement: tail, selection: null, expression: { kind: "totalGroup", expression: "Value", alias: "", hierarchy: "none", period: { unit: "month", begin: null, end: "&End" } } });
    assert.ok(core.model.text.includes("PERIODS(MONTH, , &End)"));
    assert.ok(core.model.text.lastIndexOf("TOTALS") > core.model.text.lastIndexOf("UNION ALL"));
    assert.deepEqual(core.model.issues, []);
    const result = await core.catalog({ scope: 0 }); assert.ok(result.fields.some(field => field.english === "Value"));
    const malformed = structuredClone(core.model); malformed.scopes[1].parent = malformed.scopes[1].branches[0];
    assert.throws(() => constructorModel(malformed, core.limits), { code: "protocolInvalid" });
    assert.equal(f.source.record.draft, before); assert.deepEqual(await readFile(f.files.module), disk);
    await core.cancel(); assert.equal(f.source.record.draft, before);
  });
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

for (const locale of ['ru-RU','en-US']) {
  /** The real RPC publishes one revision and leaves every rejected or cancelled edit private. */
  test(`atomic item sets and source fields preserve owner and draft (${locale})`,{skip:!executable},async t=>{
    const f=await fixture(t,locale),before=f.source.record.draft,core=await f.source.openConstructor();
    assert.equal(core.limits.bulkItems,true);
    const revision=core.model.revision;
    await core.action({kind:'editItems',statement:0,clause:0,items:[1,0],operation:{kind:'copy',to:2}});
    assert.equal(core.model.revision,String(BigInt(revision)+1n));
    assert.match(core.model.text,/A AS A2,\s*B AS B2/);
    assert.deepEqual(core.model.itemFocus.map(value=>value.item),[2,3]);
    const captured=structuredClone(core.model);
    await assert.rejects(core.action({kind:'editItems',statement:0,clause:0,items:[0,1,2,3],operation:{kind:'remove'}}));
    assert.deepEqual(core.model,captured);
    const malformed=structuredClone(captured);malformed.itemFocus[0].item=999;
    assert.throws(()=>constructorModel(malformed,core.limits),{code:'protocolInvalid'});
    await core.action({kind:'addSourceFields',statement:0,source:{kind:'source',table:'Catalog.Товары',alias:''},fields:['Артикул']});
    assert.match(core.model.text,/Товары.Артикул/);
    assert.equal(f.source.record.draft,before);assert.equal(await readFile(f.files.module,'utf8'),f.owner);
    await core.cancel();assert.equal(f.source.record.draft,before);
  });
}

for(const locale of ['ru-RU','en-US']) {
 /** Full-snapshot predicates remain private and malformed recursive DTOs cannot reach the renderer. */
 test(`structured boolean conditions are checked by the real backend (${locale})`,{skip:!executable},async t=>{
  const f=await fixture(t,locale),core=await f.source.openConstructor();assert.equal(core.limits.predicates,true);
  const predicate={kind:'any',children:[{kind:'between',expression:'A',begin:'1',end:'3'},{kind:'not',child:{kind:'isNull',expression:'B',negated:false}}]};
  await core.action({kind:'setPredicate',statement:0,clause:'conditions',selection:null,predicate});
  assert.deepEqual(core.model.statements[0].clauses.at(-1).predicate,predicate);
  const before=structuredClone(core.model);await core.action({kind:'setPredicate',statement:0,clause:'conditions',selection:null,predicate});assert.deepEqual(core.model,before);
  const malformed=structuredClone(core.model);malformed.statements[0].clauses.at(-1).predicate={kind:'not',child:{kind:'bad'}};
  assert.throws(()=>constructorModel(malformed,core.limits),{code:'protocolInvalid'});
  await assert.rejects(core.action({kind:'setPredicate',statement:0,clause:'conditions',selection:null,predicate:{kind:'compare',left:'SUM(A)',comparison:'greater',right:'0'}}));assert.deepEqual(core.model,before);
  await core.cancel();assert.equal(await readFile(f.files.module,'utf8'),f.owner);
 });
}

/** Preview and matrix inspection never publish a working revision or fill an absent cell implicitly. */
test('union matrix previews alignment without changing the acknowledged constructor',{skip:!executable},async t=>{
 const f=await fixture(t,'en-US');const text='SELECT 1 AS N UNION ALL SELECT 2 AS N, 3 AS Extra';await f.store.saveDraft(f.source.record.id,text);
 const core=await f.source.openConstructor(),before=structuredClone(core.model);assert.equal(core.limits.unionMatrix,true);assert.equal(core.model.statements[0].unionMatrix.canAlign,true);assert.equal(core.model.statements[0].unionMatrix.columns[1].cells[0],null);
 const action={kind:'alignUnion',statement:0},preview=await core.preview(action);assert.match(preview.text,/NULL AS Extra/);assert.deepEqual(core.model,before);assert.equal(f.source.record.draft,text);
 await core.action(action);assert.equal(core.model.text,preview.text);assert.equal(core.model.revision,'2');assert.deepEqual(core.model.issues,[]);
 const malformed=structuredClone(core.model);malformed.statements[0].unionMatrix.columns[0].cells[0].item=100;
 assert.throws(()=>constructorModel(malformed,core.limits),{code:'protocolInvalid'});await core.cancel();assert.equal(f.source.record.draft,text);
});
/** Preview goes through the same source/session protection as an accepted edit. */
test('read-only constructor refuses preview without allocating a new revision',{skip:!executable},async t=>{
 const f=await fixture(t,'en-US',true),core=await f.source.openConstructor(),before=structuredClone(core.model);
 await assert.rejects(core.preview({kind:'editItems',statement:0,clause:0,items:[0],operation:{kind:'copy',to:2}}),error=>error.details?.reason==='user_read_only');assert.deepEqual(core.model,before);await core.cancel();
});

/** Root copies get a separate destination and ESKA supplies both lexical breadcrumbs and lifetime-bound definitions. */
test('package tree copy allocates a new table and keeps original consumer definitions',{skip:!executable},async t=>{
 const f=await fixture(t,'ru-RU'),text='SELECT Q.N AS N INTO Tmp FROM (SELECT 7 AS N) AS Q; SELECT Tmp.N FROM Tmp; DROP Tmp';await f.store.saveDraft(f.source.record.id,text);
 const core=await f.source.openConstructor(),before=structuredClone(core.model),preview=await core.preview({kind:'copyStatement',statement:0});assert.match(preview.text,/INTO Tmp2/);assert.deepEqual(core.model,before);
 await core.action({kind:'copyStatement',statement:0});const owner=core.model.statements[core.model.focus];assert.equal(owner.package.destination,'Tmp2');assert.equal(owner.package.copy,true);
 const consumer=core.model.statements.find(owner=>owner.sources.some(source=>source.table==='Tmp'));assert.equal(consumer.sources[0].temporaryDefinition,0);
 const nested=core.model.statements.find(owner=>owner.nested);assert.deepEqual(nested.path,[0,nested.index]);assert.deepEqual(core.model.issues,[]);await core.cancel();assert.equal(f.source.record.draft,text);
});

for(const locale of ['ru-RU','en-US']) {
 /** Settings previews use native checked values and preserve one canonical draft plus its owner. */
 test(`structured modifiers roundtrip and preview through the real backend (${locale})`,{skip:!executable},async t=>{
  const f=await fixture(t,locale),core=await f.source.openConstructor(),before=structuredClone(core.model);assert.equal(core.limits.modifiers,true);assert.equal(core.limits.maxTop,4294967295);
  const modifiers={...core.model.statements[0].modifiers.value,distinct:true,allowed:true,top:0,autoOrder:true};
  const action={kind:'setModifiers',statement:0,modifiers},preview=await core.preview(action);assert.match(preview.text,/SELECT ALLOWED DISTINCT TOP 0/);assert.match(preview.text,/AUTOORDER/);assert.deepEqual(core.model,before);
  await core.action(action);assert.equal(core.model.text,preview.text);const accepted=structuredClone(core.model);await core.action(action);assert.deepEqual(core.model,accepted);
  await assert.rejects(core.action({kind:'setInto',statement:0,name:'Tmp'}));assert.deepEqual(core.model,accepted);await core.cancel();assert.equal(await readFile(f.files.module,'utf8'),f.owner);
 });
}
