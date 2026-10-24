import { test } from "node:test";
import assert from "node:assert/strict";
import { LanguageDocuments } from "../out/language/documents.js";

/** Track actual wire notifications without involving a second editor or language server. */
function fixture() {
  const sent = [], uri = "file:///project/Module.bsl";
  const document = { version: 41, isClosed: false, text: "native", getText() { return this.text; } };
  const documents = new LanguageDocuments(async (method, params) => sent.push({ method, ...params }), value => value === uri && !document.isClosed ? document : undefined);
  const native = (method, value = {}) => documents.notification(`textDocument/${method}`, { textDocument: { uri, version: document.version }, ...value }, async () => assert.fail("native synchronization must share the URI stream"));
  return { sent, uri, document, documents, native };
}

test("projection owns one URI, suppresses native traffic and restores the newest native text with increasing LSP versions", async () => {
  const { sent, uri, document, documents, native } = fixture(), owner = {};
  await native("didOpen");
  await documents.project(uri, "projected 😀", owner);
  document.text = "edited native"; document.version++;
  await native("didChange", { contentChanges: [{ text: "edited native" }] });
  assert.equal(sent.length, 2);
  assert.equal(documents.projected(uri), true); assert.equal(documents.poisoned(uri), true);
  await documents.release(uri, {}); assert.equal(sent.length, 2, "foreign release has no authority");
  await documents.release(uri, owner);
  assert.deepEqual(sent.map(value => value.method), ["textDocument/didOpen", "textDocument/didChange", "textDocument/didChange"]);
  assert.deepEqual(sent.map(value => value.textDocument.version), [1, 2, 3]);
  assert.equal(sent[2].contentChanges[0].text, "edited native");
  document.text = "again"; document.version++;
  await native("didChange"); assert.equal(sent[3].textDocument.version, 4);
  assert.equal(documents.projected(uri), false); assert.equal(documents.poisoned(uri), true);
  document.isClosed = true; await native("didClose"); assert.equal(documents.poisoned(uri), false);
});

test("queued notifications captured under projection cannot leak after release; replacement owners keep independent leases", async () => {
  const { sent, uri, document, documents, native } = fixture(), first = {}, next = {};
  await documents.project(uri, "first", first);
  await assert.rejects(documents.project(uri, "foreign", next), /language_uri_owned/);
  document.text = "new native";
  const suppressed = native("didChange"), released = documents.release(uri, first), replaced = documents.project(uri, "second", next);
  await Promise.all([suppressed, released, replaced]);
  assert.deepEqual(sent.slice(1).map(value => value.contentChanges[0].text), ["new native", "second"]);
  assert.equal(documents.projected(uri), true);
  await documents.release(uri, first); assert.equal(documents.projected(uri), true);
  document.isClosed = true; await documents.release(uri, next);
  assert.equal(sent.at(-1).method, "textDocument/didClose"); assert.equal(documents.poisoned(uri), false);
});

test("a failed projected notification still permits restoration and never writes native document state", async () => {
  const sent = [], uri = "file:///module.bsl", document = { isClosed: false, getText: () => "native" };
  let fail = false;
  const documents = new LanguageDocuments(async (method, params) => {
    assert.equal(documents.owns(params), true);
    if (fail) { fail = false; throw new Error("connection failed"); }
    sent.push({ method, ...params });
  }, () => document);
  await documents.project(uri, "one", document); await documents.release(uri, document);
  fail = true; await assert.rejects(documents.project(uri, "two", document));
  await documents.release(uri, document); await documents.settled(uri);
  assert.equal(sent.at(-1).contentChanges[0].text, "native");
  assert.equal(document.getText(), "native"); assert.equal(documents.owns({}), false);
});

test("a rapid native close and reopen starts a new wire lifetime without losing its queued open", async () => {
  const { sent, uri, document, documents, native } = fixture(), owner = {};
  await documents.project(uri, "projection", owner); await documents.release(uri, owner);
  document.isClosed = true;
  const closing = native("didClose");
  document.isClosed = false; document.text = "reopened";
  const opening = native("didOpen");
  await Promise.all([closing, opening]);
  document.text = "after reopen"; await native("didChange");
  assert.deepEqual(sent.slice(-3).map(value => value.method), ["textDocument/didClose", "textDocument/didOpen", "textDocument/didChange"]);
  assert.deepEqual(sent.slice(-2).map(value => value.textDocument.version), [1, 2]);
  assert.equal(documents.poisoned(uri), false);
  assert.equal(sent.at(-1).contentChanges[0].text, "after reopen");
});
