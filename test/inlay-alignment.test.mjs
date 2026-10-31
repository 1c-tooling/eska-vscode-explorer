import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { InlayAlignment } from "../out/language/inlays.js";
import { multilineStrings, stringCapabilities, withStringText } from "../out/language/strings.js";

const limits = { maxTextBytes: 4_194_304, maxInlineBytes: 131_072, maxContinuations: 8192 };
const hash = text => createHash("sha256").update(text).digest("hex");
const body = 'F("😀 один\r\n\t|два\r\n  |три");';
function response(text = body, version = 1) {
  const byte = offset => Buffer.byteLength(text.slice(0, offset));
  return { schemaVersion: 1, version: String(version), sourceSha256: hash(text), strings: [{
    range: { start: byte(text.indexOf('"')), end: byte(text.lastIndexOf('"') + 1) },
    continuations: [...text.matchAll(/\|/g)].map(match => byte(match.index)),
  }] };
}

test("multiline syntax capability and UTF-8 positions are bound to the exact native snapshot", () => {
  const hello = { apiVersion: { major: 1, minor: 34 }, capabilities: { bslMultilineStrings: { schemaVersion: 1,
    offsetEncoding: "utf-8", writesOwner: false, ...limits } } };
  assert.deepEqual(stringCapabilities(hello), limits);
  assert.equal(stringCapabilities({ capabilities: {} }), undefined);
  const strings = multilineStrings(response(), body, 1, limits);
  assert.deepEqual(strings, [{ start: body.indexOf('"'), end: body.lastIndexOf('"') + 1,
    continuations: [...body.matchAll(/\|/g)].map(match => match.index) }]);
  for (const patch of [{ version: "2" }, { sourceSha256: "0".repeat(64) }, { schemaVersion: 2 },
    { strings: [{ ...response().strings[0], continuations: [3] }] },
    { strings: [{ ...response().strings[0], continuations: [20, 20] }] }, { strings: [...response().strings, ...response().strings] }]) {
    assert.throws(() => multilineStrings({ ...response(), ...patch }, body, 1, limits));
  }
  assert.throws(() => stringCapabilities({ ...hello, apiVersion: { major: 1, minor: 33 } }));
});

test("syntax transfer releases its own bounded upload when the caller cancels after reservation", async () => {
  const controller = new AbortController(), calls = [];
  const endpoint = { limits: { ...limits, maxInlineBytes: 2 }, async request(method) {
    calls.push(method);
    if (method === "language/bufferBegin") { controller.abort(); return { bufferId: "owned", receivedBytes: 0, ready: false }; }
    assert.equal(method, "language/bufferClose"); return { released: true };
  } };
  await assert.rejects(withStringText(endpoint, "larger than inline", () => assert.fail("cancelled syntax used"), controller.signal));
  assert.deepEqual(calls, ["language/bufferBegin", "language/bufferClose"]);
});

class Range {
  constructor(a, b, c, d) { this.start = typeof a === "number" ? { line: a, character: b } : a; this.end = typeof a === "number" ? { line: c, character: d } : b; }
  contains(position) { const key = point => point.line * 1000000 + point.character; return key(position) >= key(this.start) && key(position) <= key(this.end); }
}
function event() {
  const listeners = new Set();
  return { add(listener) { listeners.add(listener); return { dispose: () => listeners.delete(listener) }; }, fire(value) { for (const listener of listeners) listener(value); } };
}
function gate() { let release; const promise = new Promise(done => { release = done; }); return { promise, release }; }
function fixture() {
  const events = { visible: event(), close: event(), settings: event() }, calls = [], editors = [], settings = { "inlayHints.enabled": "on" };
  const document = { text: 'F("one\n  |two\n\t|three");', version: 1, isClosed: false, languageId: "bsl", uri: { scheme: "file" },
    getText() { return this.text; }, get lineCount() { return this.text.split("\n").length; }, lineAt(line) { return { text: this.text.split("\n")[line] }; },
    positionAt(offset) { const parts = this.text.slice(0, offset).split("\n"); return { line: parts.length - 1, character: parts.at(-1).length }; },
    offsetAt(position) { const parts = this.text.split("\n"); return parts.slice(0, position.line).reduce((sum, line) => sum + line.length + 1, 0) + position.character; } };
  const makeEditor = () => { const editor = { document, values: [], styles: new Map(), setCount: 0, setDecorations(type, ranges) {
    this.setCount++;
    this.styles.set(type, ranges.map(range => ({ range, renderOptions: { before: type.options.before } })));
    this.values = [...this.styles.values()].flat();
  } }; editors.push(editor); return editor; };
  makeEditor();
  const api = { Range, ThemeColor: class { constructor(id) { this.id = id; } }, InlayHintKind: { Parameter: 2 }, DecorationRangeBehavior: { ClosedClosed: 1 },
    window: { visibleTextEditors: editors, onDidChangeVisibleTextEditors: listener => events.visible.add(listener),
      createTextEditorDecorationType: options => ({ options, dispose() {
        calls.push("dispose"); for (const editor of editors) { editor.styles.delete(this); editor.values = [...editor.styles.values()].flat(); }
      } }) },
    workspace: { onDidCloseTextDocument: listener => events.close.add(listener), onDidChangeConfiguration: listener => events.settings.add(listener),
      getConfiguration: () => ({ get: (key, fallback) => settings[key] ?? fallback }) } };
  const endpoint = { limits, async request(method, params) {
    calls.push(method); if (endpoint.wait) { endpoint.reached.release(); await endpoint.wait.promise; }
    return response(params.text, params.version);
  } };
  let valid = true, resolves = false, wire = 0;
  const alignment = new InlayAlignment(api, endpoint, () => valid, () => calls.push("refresh"), () => resolves, () => wire);
  const token = () => ({ isCancellationRequested: false });
  const hint = patch => ({ position: document.positionAt(document.text.indexOf('"')), label: "Шаблон:", kind: 2, paddingRight: true, ...patch });
  const range = new Range(0, 0, 100, 0);
  const provide = (hints = [hint()], value = token()) => alignment.provide(document, range, value, async () => hints);
  return { alignment, api, document, settings, calls, editors, events, endpoint, token, hint, range, provide, makeEditor,
    invalid: () => { valid = false; }, resolving: () => { resolves = true; }, wireChanged: () => { wire++; } };
}

test("one render advances label and continuations identically across split editors without changing text", async t => {
  const f = fixture(); t.after(() => f.alignment.dispose()); const before = f.document.text;
  f.makeEditor();
  assert.deepEqual(await f.provide(), []);
  for (const editor of f.editors) {
    assert.equal(editor.values.length, 3);
    const styles = editor.values.map(value => value.renderOptions.before);
    assert.equal(styles[0].contentText, "Шаблон:\u00a0");
    assert.equal(styles[1].contentText, styles[0].contentText);
    assert.equal(styles[2].margin, styles[0].margin);
    assert.equal(styles[1].color, "transparent");
  }
  const sets = f.editors[0].setCount;
  await f.provide();
  assert.equal(f.editors[0].setCount, sets, "identical hints cannot trigger another editor decoration update");
  assert.equal(f.calls.filter(method => method === "language/multilineStrings").length, 1, "same-version geometry is reused across viewport requests");
  f.makeEditor(); f.events.visible.fire(); assert.equal(f.editors[2].values.length, 3);
  assert.equal(f.document.text, before); assert.equal(f.document.version, 1);
});

test("native actions, resolution and conditional visibility remain with the standard provider", async t => {
  const f = fixture(); t.after(() => f.alignment.dispose());
  for (const patch of [{ tooltip: "native hover" }, { label: [{ value: "native", command: { command: "example" } }] }, { textEdits: [{ newText: "edit" }] }, { kind: 1 }]) {
    const hint = f.hint(patch); assert.deepEqual(await f.provide([hint]), [hint]);
  }
  for (const enabled of ["off", "offUnlessPressed", "onUnlessPressed"]) {
    f.settings["inlayHints.enabled"] = enabled; const hint = f.hint(); assert.deepEqual(await f.provide([hint]), [hint]);
    assert.equal(f.editors[0].values.length, 0);
  }
  f.settings["inlayHints.enabled"] = "on"; f.resolving(); const hint = f.hint(); assert.deepEqual(await f.provide([hint]), [hint]);
  assert.equal(f.calls.filter(method => method === "language/multilineStrings").length, 0);
});

test("setting changes, edits and shutdown clear attachments before any obsolete reply can return", async t => {
  const f = fixture(); t.after(() => f.alignment.dispose());
  await f.provide();
  f.settings["inlayHints.enabled"] = "off"; f.events.settings.fire({ affectsConfiguration: () => true });
  assert.equal(f.editors[0].values.length, 0); assert.ok(f.calls.includes("refresh"));
  f.settings["inlayHints.enabled"] = "on"; f.endpoint.wait = gate(); f.endpoint.reached = gate();
  const pending = f.provide(); await f.endpoint.reached.promise;
  f.document.text = "// newer buffer\n" + f.document.text; f.document.version++;
  f.alignment.invalidate(); f.endpoint.wait.release();
  assert.equal(await pending, undefined); assert.equal(f.editors[0].values.length, 0);
  f.endpoint.wait = undefined; await f.provide(); assert.equal(f.editors[0].values.length, 3);
  f.alignment.dispose(); assert.equal(f.editors[0].values.length, 0);
});

test("a cancelled reader cannot cancel another split reader's shared geometry", async t => {
  const f = fixture(); t.after(() => f.alignment.dispose());
  f.endpoint.wait = gate(); f.endpoint.reached = gate(); const firstToken = f.token();
  const one = f.provide(undefined, firstToken); await f.endpoint.reached.promise;
  const two = f.provide(); firstToken.isCancellationRequested = true; f.endpoint.wait.release();
  assert.equal(await one, undefined); assert.deepEqual(await two, []); assert.equal(f.editors[0].values.length, 3);
  assert.equal(f.calls.filter(method => method === "language/multilineStrings").length, 1);
});

test("nested and preceding argument hints contribute their entire advance to every continuation", async t => {
  const f = fixture(); t.after(() => f.alignment.dispose());
  const outer = f.hint({ position: { line: 0, character: 0 }, label: "Внешний:" }), inner = f.hint();
  f.settings["inlayHints.padding"] = true;
  assert.deepEqual(await f.provide([outer, inner]), []);
  const values = f.editors[0].values.map(value => value.renderOptions.before);
  assert.equal(values.length, 4);
  assert.equal(values[2].contentText, "Внешний:\u00a0Шаблон:\u00a0");
  assert.equal(values[2].margin, "0 0.25em");
  assert.equal(values[3].contentText, values[2].contentText);
  f.alignment.invalidate();
  const actionable = { ...outer, tooltip: "native action" };
  assert.deepEqual(await f.provide([actionable, inner]), [actionable, inner]);
  assert.equal(f.editors[0].values.length, 0);
});

test("a projection epoch change discards a late result even when native text and version stay equal", async t => {
  const f = fixture(); t.after(() => f.alignment.dispose());
  f.endpoint.wait = gate(); f.endpoint.reached = gate();
  const pending = f.provide(); await f.endpoint.reached.promise;
  f.wireChanged(); f.endpoint.wait.release();
  assert.equal(await pending, undefined); assert.equal(f.editors[0].values.length, 0);
});

test("closing and reopening the same URI at the same version never adopts the old document identity", async t => {
  const f = fixture(); t.after(() => f.alignment.dispose());
  await f.provide(); const old = f.document;
  old.isClosed = true; f.events.close.fire(old);
  assert.equal(f.editors[0].values.length, 0);
  const document = { ...old, isClosed: false, lineAt: line => old.lineAt(line), lineCount: old.lineCount };
  f.editors[0].document = document;
  const result = await f.alignment.provide(document, f.range, f.token(), async () => [f.hint()]);
  assert.deepEqual(result, []); assert.equal(f.editors[0].values.length, 3);
  assert.equal(f.calls.filter(method => method === "language/multilineStrings").length, 2);
});
