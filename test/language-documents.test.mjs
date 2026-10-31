import { test } from "node:test";
import assert from "node:assert/strict";
import { LanguageDocuments } from "../out/language/documents.js";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

/** Track actual wire notifications without involving a second editor or language server. */
function fixture() {
  const sent = [], uri = "file:///project/Module.bsl";
  const document = { uri: { toString: () => uri }, version: 41, isClosed: false, text: "native", getText() { return this.text; } };
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

test("wire versions identify only the current synchronized native document after projection", async () => {
  const { uri, document, documents, native } = fixture(), owner = {};
  assert.equal(documents.wireVersion(document), undefined);
  await native("didOpen"); assert.equal(documents.wireVersion(document), 1);
  await documents.project(uri, "projected", owner); assert.equal(documents.wireVersion(document), undefined);
  document.version++; document.text = "latest native";
  await native("didChange"); assert.equal(documents.wireVersion(document), undefined);
  await documents.release(uri, owner); assert.equal(documents.wireVersion(document), 3);
  document.version++; assert.equal(documents.wireVersion(document), undefined, "an unsent native body cannot authorize an edit");
  await native("didChange"); assert.equal(documents.wireVersion(document), 4);
  assert.equal(documents.wireVersion({ ...document }), undefined, "a different document lifetime has no mapping");
  document.isClosed = true; assert.equal(documents.wireVersion(document), undefined);
});

test("Windows native and upstream URI spellings own one stream across projection and restoration", { skip: process.platform !== "win32" }, async () => {
  const standard = pathToFileURL(resolve(process.env.ESKA_TEST_ROOT ?? "../eska-playground", "URI Тест #.bsl")
    .replace(/^[a-z]:/i, drive => drive.toUpperCase())).href;
  const native = standard.replace(/^file:\/\/\/([a-z]):/i, (_value, drive) => `file:///${drive.toLowerCase()}%3A`);
  const sent = [], owner = {}, document = { version: 41, isClosed: false, getText: () => "native" };
  const documents = new LanguageDocuments(async (method, params) => sent.push({ method, ...params }),
    uri => uri === standard ? document : undefined);
  await documents.notification("textDocument/didOpen", { textDocument: { uri: native } }, () => assert.fail("one owned stream"));
  await documents.project(native, "projected", owner);
  assert.equal(documents.projected(standard), true);
  await documents.release(standard, owner);
  assert.equal(documents.projected(native), false);
  assert.deepEqual(sent.map(value => value.textDocument.uri), [standard, standard, standard]);
  assert.deepEqual(sent.map(value => value.textDocument.version), [1, 2, 3]);
  assert.equal(sent.at(-1).contentChanges[0].text, "native");
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

test("pending native open flushed by the client cannot wait on its own projection notification", async () => {
  const uri = "file:///module.bsl", owner = {}, sent = [];
  const document = { isClosed: false, getText: () => "native" };
  let pendingOpen = true, projected = false;
  const documents = new LanguageDocuments(async (method, params) => {
    assert.equal(documents.owns(params), true);
    if (pendingOpen) {
      pendingOpen = false;
      // LanguageClient.sendNotification flushes hidden native documents before sending the projected body.
      await documents.notification("textDocument/didOpen", { textDocument: { uri, version: 1, text: "native" } },
        async () => assert.fail("a projected URI cannot expose the stale native body"));
    }
    sent.push({ method, ...params });
  }, () => document);
  const opening = documents.project(uri, "projected", owner).then(() => { projected = true; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(projected, true, "suppressed native traffic must not wait for the projection that triggered it");
  await opening;
  assert.equal(sent.length, 1);
  assert.equal(sent[0].textDocument.text, "projected");
  await documents.release(uri, owner);
  assert.equal(sent.at(-1).contentChanges[0].text, "native");
  assert.equal(document.getText(), "native");
});


test("disabling closes only wire buffers, suppresses edits and reopens the latest dirty native body", async () => {
  const sent = [], uri = "file:///project/Module.bsl";
  let active = true;
  const document = { uri: { toString: () => uri }, version: 4, isClosed: false, isDirty: true, text: "unsaved", getText() { return this.text; } };
  const documents = new LanguageDocuments(async (method, params) => sent.push({method, ...params}), () => document, () => active);
  const native = method => documents.notification("textDocument/"+method, {textDocument:{uri}}, async () => assert.fail("wire sync bypassed"));
  await native("didOpen"); const before = documents.wireVersion(document);
  active = false; await documents.reconcileActivity();
  assert.equal(documents.wireVersion(document), undefined);
  document.text += " edited while disabled"; document.version++;
  await native("didChange"); await native("didSave");
  assert.deepEqual(sent.map(value=>value.method), ["textDocument/didOpen","textDocument/didClose"]);
  await assert.rejects(documents.project(uri,"private",{}), /language_uri_inactive/);
  assert.equal(document.isDirty, true);
  active = true; await documents.reconcileActivity();
  assert.equal(sent.at(-1).method,"textDocument/didOpen");
  assert.equal(sent.at(-1).textDocument.text,document.text);
  assert.ok(documents.wireVersion(document)>before);
  const count = sent.length; await documents.reconcileActivity(); assert.equal(sent.length,count,"unchanged active buffers are not resent");
});

test("releasing a disabled private projection never sends a native owner body until explicit activation", async () => {
  const sent = [], uri = "file:///project/Owner.bsl", owner = {};
  let active = true;
  const document = {version:1,isClosed:false,getText:()=>"native remains dirty"};
  const documents = new LanguageDocuments(async (method,params)=>sent.push({method,...params}),()=>document,()=>active);
  await documents.project(uri,"private draft",owner);
  active=false; await documents.reconcileActivity(); await documents.release(uri,owner);
  assert.deepEqual(sent.map(value=>value.method),["textDocument/didOpen","textDocument/didClose"]);
  active=true; await documents.reconcileActivity(); assert.equal(sent.at(-1).textDocument.text,document.getText());
});
