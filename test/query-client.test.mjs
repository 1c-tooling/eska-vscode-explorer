import { test } from "node:test";
import assert from "node:assert/strict";
import { QueryClient, querySnapshot } from "../out/query/client.js";
import { QUERY_LIMITS, queryCapabilities } from "../out/query/protocol.js";
import { parsePlan } from "../out/query/plan.js";
import { MAX_REQUEST } from "../out/protocol.js";

/** Faults are injected at acknowledged RPC boundaries, without mocking UTF-8 or the client under test. */
function client(handle, limits = QUERY_LIMITS) {
  const calls = [];
  const project = { info: { generation: "9007199254740993", projectId: "p", requiresReopen: false, requiresRefresh: false } };
  const connection = { async request(session, method, params, signal) {
    calls.push({ session, method, params, signal });
    const result = await handle(method, params);
    return { sessionId: session, projectId: "p", generation: params.generation, ...result };
  } };
  return { value: new QueryClient(connection, "s", project, limits), calls, project };
}

/** Independent capability data follows the published protocol, not the runtime's object identity. */
function capabilities(overrides = {}) {
  return { apiVersion: { major: 1, minor: 13 }, capabilities: { queryEditing: {
    schemaVersion: 1, planOnly: true, writesOwner: false, sourceKinds: ["form", "bsl", "dataCompositionSchema"],
    maxSnapshotBytes: 8388608, maxInlineBytes: 131072, maxRetainedBytes: 33554432, maxDocuments: 16,
    maxRetainedEntries: 64, maxMappingPositions: 64, maxListItems: 64, maxXmlQueries: 1024,
    maxMappings: 65536, maxSourceComments: 8192, ...overrides,
  } } };
}

test("query capabilities require plan-only schema and cap peer resource bounds", () => {
  assert.equal(queryCapabilities({ capabilities: {} }), undefined);
  assert.deepEqual(queryCapabilities(capabilities()), QUERY_LIMITS);
  assert.equal(queryCapabilities(capabilities({ maxInlineBytes: 262144 })).maxInlineBytes, 131072);
  for (const bad of [{ writesOwner: true }, { planOnly: false }, { schemaVersion: 2 }, { maxDocuments: -1 },
    { maxSnapshotBytes: 1.5 }, { maxInlineBytes: 0 }, { maxMappings: Number.MAX_SAFE_INTEGER + 1 }]) {
    assert.throws(() => queryCapabilities(capabilities(bad)), { code: "protocolInvalid" });
  }
});

test("large buffers use sequential Unicode-safe chunks under the unchanged frame bound", async () => {
  const text = "a".repeat(131071) + "😀\"\n".repeat(40000) + "Конец";
  const parts = [];
  let received = 0;
  const { value, calls } = client((method, params) => {
    if (method === "query/bufferBegin") {
      assert.equal(params.bytes, Buffer.byteLength(text));
      assert.equal(params.snapshot, querySnapshot(text));
      return { bufferId: "b1", receivedBytes: 0, ready: false };
    }
    if (method === "query/bufferAppend") {
      assert.equal(params.offset, received);
      assert.ok(Buffer.byteLength(params.text) <= 131072);
      assert.ok(Buffer.byteLength(JSON.stringify({ jsonrpc: "2.0", method, params })) < MAX_REQUEST);
      assert.equal(Buffer.from(params.text).toString(), params.text);
      parts.push(params.text); received += Buffer.byteLength(params.text);
      return { bufferId: "b1", receivedBytes: received, ready: received === Buffer.byteLength(text) };
    }
    assert.equal(method, "query/bufferClose");
    return { released: true };
  });
  const result = await value.withText(text, "9007199254740993", async input => {
    assert.deepEqual(input, { bufferId: "b1" }); return "used";
  });
  assert.equal(result, "used"); assert.equal(parts.join(""), text);
  assert.equal(calls.at(-1).method, "query/bufferClose");
  assert.ok(calls.every(call => call.signal === undefined), "allocation replies cannot be lost to cancellation");
});

test("cancelled allocation and failed append both release their acknowledged upload", async () => {
  for (const failure of ["cancel", "append", "generation", "malformed"]) {
    const controller = new AbortController();
    const stand = client((method, params) => {
      if (method === "query/bufferBegin") {
        if (failure === "cancel") controller.abort();
        return { bufferId: "b1", receivedBytes: failure === "malformed" ? 1 : 0, ready: false };
      }
      if (method === "query/bufferAppend") {
        if (failure === "append") throw new Error("injected append failure");
        if (failure === "generation") stand.project.info.generation = "9007199254740994";
        return { bufferId: "b1", receivedBytes: Buffer.byteLength(params.text), ready: false };
      }
      assert.equal(method, "query/bufferClose"); return { released: true };
    });
    await assert.rejects(stand.value.withText("я".repeat(100000), "9007199254740993", async () => assert.fail("not admitted"), controller.signal));
    assert.equal(stand.calls.at(-1).method, "query/bufferClose", failure);
    assert.equal(stand.calls.at(-1).params.generation, "9007199254740993");
  }
});

test("oversized and malformed UTF-16 buffers allocate nothing", async () => {
  const { value, calls } = client(() => assert.fail("no transport call"));
  await assert.rejects(value.withText("x".repeat(8388609), "9007199254740993", async () => {}), { code: "resourceLimit" });
  await assert.rejects(value.withText("bad\ud800", "9007199254740993", async () => {}), { code: "sourceChanged" });
  assert.deepEqual(calls, []);
});

test("cancelled or invalidated owner opens close their exact document handle", async () => {
  const text = "<Form/>";
  for (const failure of ["cancel", "generation"]) {
    const controller = new AbortController();
    const stand = client(method => {
      if (method === "query/open") {
        if (failure === "cancel") controller.abort(); else stand.project.info.generation = "9007199254740994";
        return { documentId: "d1", version: "7", snapshot: querySnapshot(text), diskSnapshot: querySnapshot(text),
          contextFingerprint: "a".repeat(64), source: { value: "Form.xml", encoding: "utf-8" },
          sourceKind: "form", application: null, writable: true, limitedContext: false };
      }
      assert.equal(method, "query/close"); return { released: true };
    });
    await assert.rejects(stand.value.open({ node: { kind: "object", objectId: "form:x" },
      source: { value: "Form.xml", encoding: "utf-8" }, version: "7", text }, controller.signal));
    assert.equal(stand.calls.at(-1).method, "query/close");
    assert.equal(stand.calls.at(-1).params.documentId, "d1");
  }
});

/** A no-op with forged replacement coordinates must not be allowed to address an editor. */
test("plan validation rejects wrong hash, surrogate and CRLF interiors, and overlapping edits", () => {
  const original = "😀\r\nX";
  const identity = { kind: "bslLiteral", range: { start: 0, end: Buffer.byteLength(original) } };
  const position = { line: 0, character: 0 };
  const projectedQuery = { identity, text: original, sourceRange: identity.range,
    sourceRangeUtf16: { start: position, end: { line: 1, character: 1 } }, comments: [],
    map: { encoding: "utf-8", spans: [], anchors: { startBefore: 0, startAfter: 0, endBefore: 7, endAfter: 7 } } };
  const base = { noOp: true, outputSnapshot: querySnapshot(original), replacements: [], projectedQuery };
  assert.equal(parsePlan(base, original, querySnapshot(original), identity, QUERY_LIMITS).noOp, true);
  for (const bad of [
    { ...base, outputSnapshot: "f".repeat(64) },
    { ...base, noOp: false, replacements: [{ range: { start: 1, end: 2 }, rangeUtf16: { start: position, end: position }, text: "" }] },
    { ...base, noOp: false, replacements: [{ range: { start: 5, end: 5 }, rangeUtf16: { start: { line: 1, character: 0 }, end: { line: 1, character: 0 } }, text: "" }] },
    { ...base, noOp: false, replacements: [
      { range: { start: 0, end: 4 }, rangeUtf16: { start: position, end: { line: 0, character: 2 } }, text: "" },
      { range: { start: 0, end: 0 }, rangeUtf16: { start: position, end: position }, text: "" }] },
  ]) assert.throws(() => parsePlan(bad, original, querySnapshot(original), identity, QUERY_LIMITS), { code: "protocolInvalid" });
});
