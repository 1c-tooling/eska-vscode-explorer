import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile, symlink, rm } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { runInNewContext } from "node:vm";

/** Deterministically pause a protocol/policy boundary, never a wall-clock guess. */
function barrier() { let release; const promise = new Promise(done => { release = done; }); return { promise, release }; }

class Position {
  constructor(line, character) { this.line = line; this.character = character; }
  isEqual(other) { return this.line === other.line && this.character === other.character; }
}
class Uri {
  constructor(value) { this.value = new URL(value); }
  static file(path) { return new Uri(pathToFileURL(path)); }
  static parse(value) { return new Uri(value); }
  get scheme() { return this.value.protocol.slice(0, -1); }
  get fsPath() { return fileURLToPath(this.value); }
  get query() { return this.value.search.slice(1); }
  get fragment() { return this.value.hash.slice(1); }
  toString() { return this.value.href; }
}

/** Editor primitives are mocked, but canonical paths, symlinks, file metadata and I/O races use real owned files. */
async function fixture(t) {
  const root = await mkdtemp(join(process.env.ESKA_TEST_ROOT ?? resolve("../eska-playground"), "explorer-language-edits-")), source = join(root, "src");
  t.after(() => rm(root, { recursive: true, force: true })); await mkdir(source);
  const files = [join(source, "a.bsl"), join(source, "b.bsl")], text = "Переменная = 1;\n";
  await Promise.all(files.map(file => writeFile(file, text)));
  const docs = new Map(), commands = new Map(), applications = [], warnings = [], policy = new Set(), readonly = new Set();
  let active = true, model = 0, authorize = async () => {}, convert = async () => {}, apply = async () => true;
  const timers = new Set();
  const document = async uri => {
    const key = uri.toString(); if (docs.has(key)) return docs.get(key);
    const value = { uri, version: 1, isClosed: false, languageId: "bsl", text: await readFile(uri.fsPath, "utf8"),
      getText() { return this.text; },
      offsetAt(position) { const lines = this.text.split("\n"); const line = Math.min(position.line, lines.length - 1); return lines.slice(0, line).reduce((size, value) => size + value.length + 1, 0) + Math.min(position.character, lines[line].length); },
      positionAt(offset) { const lines = this.text.slice(0, offset).split("\n"); return new Position(lines.length - 1, lines.at(-1).length); } };
    docs.set(key, value); return value;
  };
  const opened = await Promise.all(files.map(file => document(Uri.file(file))));
  const vscode = { Uri, Position, CancellationError: class extends Error {}, RelativePattern: class { constructor(_base, pattern) { this.pattern = pattern; } },
    env: { language: "en-US" },
    workspace: { get textDocuments() { return [...docs.values()]; }, fs: { isWritableFileSystem: () => true }, openTextDocument: document,
      getWorkspaceFolder: () => ({ uri: Uri.file(root) }),
      getConfiguration(_section, uri) { return { get(key, fallback) { return key === "readonlyInclude" && readonly.has(uri.fsPath) ? { [uri.fsPath]: true } : fallback; } }; },
      async applyEdit(edit) { applications.push(edit); return apply(); } },
    languages: { match(selector, doc) { return (typeof selector.pattern === "string" ? selector.pattern : selector.pattern.pattern) === doc.uri.fsPath ? 10 : 0; } },
    commands: { registerCommand(id, command) { assert.ok(!commands.has(id)); commands.set(id, command); return { dispose() { commands.delete(id); } }; } },
    window: { async showWarningMessage(text) { warnings.push(text); } } };
  const reply = { rename: undefined, actions: [] }, capabilities = { workspace: { workspaceEdit: { resourceOperations: ["create", "rename", "delete"], snippetEditSupport: true } } };
  const client = { registerFeature(feature) { feature.fillClientCapabilities(capabilities); },
    code2ProtocolConverter: { asTextDocumentIdentifier: doc => ({ uri: doc.uri.toString() }), asPosition: value => value, asRange: value => value,
      asCodeActionContextSync: value => value, async asCodeActionContext(value) { return value; } },
    protocol2CodeConverter: { async asWorkspaceEdit(raw) { await convert(); return { raw }; }, async asCodeAction(value) { return { ...value }; } },
    async sendRequest(method) { return method === "textDocument/rename" ? reply.rename : reply.actions; } };
  const support = { async languageWriteAccess(paths) { await authorize(); if (paths.some(path => policy.has(path))) throw new Error("locked"); return () => !paths.some(path => policy.has(path)); } };
  const adapter = { exports: {} }, require = createRequire(new URL("../out/language/edits.js", import.meta.url));
  const policyModule = { exports: {} };
  runInNewContext(`(function(require,module,exports){${readFileSync(new URL("../out/editor-policy.js", import.meta.url), "utf8")}\n})`, {})(
    name => name === "vscode" ? vscode : require(name), policyModule, policyModule.exports);
  runInNewContext(`(function(require,module,exports){${readFileSync(new URL("../out/language/edits.js", import.meta.url), "utf8")}\n})`, {
    process, structuredClone, setTimeout(callback) { timers.add(callback); return callback; }, clearTimeout(callback) { timers.delete(callback); },
  })(
    name => name === "vscode" ? vscode : name === "../editor-policy.js" ? policyModule.exports : require(name), adapter, adapter.exports);
  const edits = new adapter.exports.LanguageEdits(client, { sources: [{ source }] }, support, () => active, () => {}, () => model);
  t.after(() => edits.shutdown());
  const change = (index, version = opened[index].version) => ({ textDocument: { uri: opened[index].uri.toString(), version },
    edits: [{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 10 } }, newText: "Значение" }] });
  return { root, source, files, opened, edits, middleware: edits.middleware(), applications, warnings, policy, readonly, reply, commands, capabilities, change,
    /** Simulate a close without leaving the file open in the request snapshot. */
    closeDocument(index) { opened[index].isClosed = true; docs.delete(opened[index].uri.toString()); },
    /** Advance the guard's only timer deterministically; protocol and I/O boundaries use explicit barriers. */
    expireTimers() { for (const callback of [...timers]) callback(); },
    setActive(value) { active = value; }, setAuthorize(value) { authorize = value; }, setConvert(value) { convert = value; }, setApply(value) { apply = value; },
    /** A dependency change supersedes pending actions even when target text versions stay equal. */
    advanceModel() { model++; } };
}

test("one blocked target rejects the whole WorkspaceEdit; an allowed multi-file edit reaches one native transaction", async t => {
  const f = await fixture(t), edit = { documentChanges: [f.change(0), f.change(1)] };
  f.policy.add(f.files[1]);
  assert.equal((await f.middleware.workspace.handleApplyEdit({ edit })).applied, false); assert.equal(f.applications.length, 0);
  f.policy.clear(); assert.equal((await f.middleware.workspace.handleApplyEdit({ edit })).applied, true);
  assert.equal(f.applications.length, 1); assert.deepEqual(JSON.parse(JSON.stringify(f.applications[0].raw)), edit);
  assert.equal(f.capabilities.workspace.workspaceEdit.resourceOperations.length, 0); assert.equal(f.capabilities.workspace.workspaceEdit.snippetEditSupport, false);
});

test("stale, unversioned, protected and resource edits cannot partially apply an otherwise permitted target", async t => {
  const f = await fixture(t), good = f.change(0), uri = f.opened[1].uri.toString();
  const bad = [
    { ...f.change(1), textDocument: { uri, version: 99 } },
    { ...f.change(1), textDocument: { uri, version: null } },
    { ...f.change(1), textDocument: { uri: uri.replace("file:", "eska-protected:"), version: 1 } },
    { ...f.change(1), textDocument: { uri: `${uri}#alias`, version: 1 } },
    { kind: "create", uri: Uri.file(join(f.source, "new.bsl")).toString() },
    { kind: "delete", uri }, { kind: "rename", oldUri: uri, newUri: Uri.file(join(f.source, "new.bsl")).toString() },
    { ...f.change(1), edits: [{ newText: "x", range: { start: { line: 999, character: 0 }, end: { line: 999, character: 1 } } }] },
    { ...f.change(1), edits: [...f.change(1).edits, ...f.change(1).edits] },
  ];
  for (const target of bad) assert.equal((await f.middleware.workspace.handleApplyEdit({ edit: { documentChanges: [good, target] } })).applied, false);
  assert.equal((await f.middleware.workspace.handleApplyEdit({ edit: { changes: { [uri]: f.change(1).edits } } })).applied, false);
  assert.equal(f.applications.length, 0); assert.equal(await readFile(f.files[0], "utf8"), f.opened[0].text);
});

test("canonical checks reject a symlink spelling of an otherwise editable source", { skip: process.platform === "win32" }, async t => {
  const f = await fixture(t), alias = join(f.source, "alias.bsl"); await symlink(f.files[1], alias);
  const edit = { documentChanges: [f.change(0), { ...f.change(1), textDocument: { uri: Uri.file(alias).toString(), version: 1 } }] };
  assert.equal((await f.middleware.workspace.handleApplyEdit({ edit })).applied, false); assert.equal(f.applications.length, 0);
});

test("an on-disk change during backend authorization invalidates the entire transaction", async t => {
  const f = await fixture(t), entered = barrier(), held = barrier();
  f.setAuthorize(async () => { entered.release(); await held.promise; });
  const pending = f.middleware.workspace.handleApplyEdit({ edit: { documentChanges: [f.change(0), f.change(1)] } });
  await entered.promise; await writeFile(f.files[1], "Другой текст\n"); held.release();
  assert.equal((await pending).applied, false); assert.equal(f.applications.length, 0);
});

test("a document or session change during conversion cannot pass the last synchronous apply check", async t => {
  const f = await fixture(t), entered = barrier(), held = barrier();
  f.setConvert(async () => { entered.release(); await held.promise; });
  const pending = f.middleware.workspace.handleApplyEdit({ edit: { documentChanges: [f.change(0), f.change(1)] } });
  await entered.promise; f.opened[1].version++; f.setActive(false); held.release();
  assert.equal((await pending).applied, false); assert.equal(f.applications.length, 0);
});

test("code actions recheck permissions and original source versions when the user finally invokes them", async t => {
  const f = await fixture(t), token = { isCancellationRequested: false };
  f.reply.actions = [{ title: "Fix", edit: { documentChanges: [f.change(0), f.change(1)] } }];
  const provide = () => f.middleware.provideCodeActions(f.opened[0], {}, { diagnostics: [] }, token);
  let [action] = await provide(); assert.equal(action.edit, undefined); assert.ok(action.command);
  f.policy.add(f.files[1]); assert.equal(await f.commands.get(action.command.command)(action.command.arguments[0]), false);
  f.policy.clear(); [action] = await provide(); f.opened[0].version++;
  assert.equal(await f.commands.get(action.command.command)(action.command.arguments[0]), false); assert.equal(f.applications.length, 0);
  f.reply.actions = [{ title: "Fix", edit: { documentChanges: [f.change(0), f.change(1)] } }];
  [action] = await provide(); assert.equal(await f.commands.get(action.command.command)(action.command.arguments[0]), true);
  assert.equal(f.applications.length, 1);
});

test("formatting and rename preserve valid results but reject a changed or voluntarily read-only buffer", async t => {
  const f = await fixture(t), token = { isCancellationRequested: false }, options = { tabSize: 4, insertSpaces: true };
  const result = [{ range: { start: new Position(0, 0), end: new Position(0, 10) }, newText: "Значение" }];
  assert.equal(await f.middleware.provideDocumentFormattingEdits(f.opened[0], options, token, async () => result), result);
  f.readonly.add(f.files[0]); assert.equal(await f.middleware.provideDocumentFormattingEdits(f.opened[0], options, token, async () => result), undefined);
  f.readonly.clear(); f.reply.rename = { documentChanges: [f.change(0), f.change(1)] };
  assert.ok(await f.middleware.provideRenameEdits(f.opened[0], new Position(0, 1), "Другое", token));
  f.reply.rename.documentChanges[1].textDocument.version = 99;
  assert.equal(await f.middleware.provideRenameEdits(f.opened[0], new Position(0, 1), "Другое", token), undefined);
  const entered = barrier(), held = barrier();
  const pending = f.middleware.provideDocumentFormattingEdits(f.opened[0], options, token, async () => { entered.release(); await held.promise; return result; });
  await entered.promise; f.opened[0].version++; held.release(); assert.equal(await pending, undefined);
});

test("an unversioned quick fix retains the disk snapshot captured before its action was offered", async t => {
  const f = await fixture(t), token = { isCancellationRequested: false };
  f.reply.actions = [{ title: "Fix", edit: { changes: { [f.opened[0].uri.toString()]: f.change(0).edits, [f.opened[1].uri.toString()]: f.change(1).edits } } }];
  const [action] = await f.middleware.provideCodeActions(f.opened[0], {}, { diagnostics: [] }, token);
  assert.ok(action.command);
  await writeFile(f.files[1], "Текст изменён после показа действия\n");
  assert.equal(await f.commands.get(action.command.command)(action.command.arguments[0]), false);
  assert.equal(f.applications.length, 0);
});

test("an unversioned quick fix cannot guess the request-time contents of an unopened target", async t => {
  const f = await fixture(t), token = { isCancellationRequested: false };
  f.closeDocument(1);
  f.reply.actions = [{ title: "Fix", edit: { changes: { [f.opened[1].uri.toString()]: f.change(1).edits } } }];
  const [action] = await f.middleware.provideCodeActions(f.opened[0], {}, { diagnostics: [] }, token);
  assert.ok(action.disabled); assert.equal(action.command, undefined);
  assert.equal(f.applications.length, 0);
});

test("an unresponsive native edit cannot indefinitely retain shutdown or pending action commands", async t => {
  const f = await fixture(t), entered = barrier(), held = barrier();
  f.setApply(async () => { entered.release(); return held.promise; });
  const applying = f.middleware.workspace.handleApplyEdit({ edit: { documentChanges: [f.change(0)] } });
  await entered.promise;
  const stopping = f.edits.shutdown();
  f.expireTimers(); await stopping;
  assert.equal(f.commands.size, 0);
  assert.equal((await f.middleware.workspace.handleApplyEdit({ edit: { documentChanges: [f.change(0)] } })).applied, false);
  held.release(true); assert.equal((await applying).applied, true);
});

test("a quick fix from an older metadata model cannot write an unchanged target buffer", async t => {
  const f = await fixture(t), token = { isCancellationRequested: false };
  f.reply.actions = [{ title: "Fix", edit: { documentChanges: [f.change(0)] } }];
  const [action] = await f.middleware.provideCodeActions(f.opened[0], {}, { diagnostics: [] }, token);
  f.advanceModel();
  assert.equal(await f.commands.get(action.command.command)(action.command.arguments[0]), false);
  assert.equal(f.applications.length, 0);
});
