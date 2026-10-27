import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';
import { createHash } from 'node:crypto';

/** Deterministically hold a formatter response while native editing invalidates its version. */
function barrier() { let release; const promise = new Promise(done => { release = done; }); return { release, promise }; }

/** Mock only the editor and process boundary; source guards and actual formatting are covered by real RPC tests. */
function fixture(t) {
  const handlers = {}, providers = {}, warnings = [], calls = [], settings = {}, params = [];
  let readonly = false, pending = async () => {}, projectCalls = 0;
  const register = name => callback => { handlers[name] = callback; return { dispose() {} }; };
  class Range { constructor(start, end) { this.start = start; this.end = end; } }
  const vscode = { env: { language: 'en-US' }, Range, TextEdit: { replace: (range, text) => ({ range, newText: text }) },
    workspace: { isTrusted: true, getConfiguration: section => ({ get: (key, fallback) => settings[section + '.' + key] ?? fallback }),
      onWillSaveTextDocument: register('save'), onDidChangeTextDocument: register('change'), onDidCloseTextDocument: register('close'), onDidChangeConfiguration: register('configuration') },
    languages: { registerDocumentFormattingEditProvider(selector, provider) { providers.document = provider; providers.selector = selector; return { dispose() {} }; },
      registerDocumentRangeFormattingEditProvider(_selector, provider) { providers.range = provider; return { dispose() {} }; } },
    window: { async showWarningMessage(text) { warnings.push(text); } } };
  const produce = async (method, input) => {
    calls.push(method); params.push(input); await pending();
    return { schemaVersion: 1, version: input.version, plan: { schema_version: 1, source_sha256: createHash('sha256').update(input.text).digest('hex'),
      formatted_range: { start: 0, end: Buffer.byteLength(input.text) }, edits: [{ range: { start: 0, end: Buffer.byteLength(input.text) }, text: 'Value = 1;\n' }] } };
  };
  class Backend { async endpoint() { return { limits: { maxTextBytes: 4_194_304, maxInlineBytes: 131_072 }, request: produce }; } async stop() {} async shutdown() {} }
  const adapter = { exports: {} }, require = createRequire(new URL('../out/formatting/service.js', import.meta.url));
  runInNewContext(`(function(require,module,exports){${readFileSync(new URL('../out/formatting/service.js', import.meta.url), 'utf8')}\n})`, { Buffer, AbortController, AbortSignal, Promise })(name =>
    name === 'vscode' ? vscode : name === './backend.js' ? { FormattingBackend: Backend }
      : name === '../query/tabs.js' ? { QUERY_SCHEME: 'eska-query' }
        : name === '../query/owner.js' ? { nativeReadOnly: async () => readonly } : require(name), adapter, adapter.exports);
  const service = new adapter.exports.FormattingService('test', { formatting: (doc, range, formatter, signal) => produce('query', { text: doc.getText(), version: String(doc.version), range, formatter, signal }) },
    { async ensureProject() { projectCalls++; return '/owned/eska-project'; } }, () => {});
  t.after(() => service.shutdown());
  const document = { version: 1, isClosed: false, languageId: 'bsl', uri: { scheme: 'file', fsPath: '/owned/source.bsl' }, getText() { return 'Value=1;\n'; }, offsetAt: position => position.character, positionAt: offset => ({ line: 0, character: offset }) };
  return { handlers, providers, warnings, calls, params, settings, document, service, get projectCalls() { return projectCalls; },
    set readonly(value) { readonly = value; }, set pending(value) { pending = value; } };
}

/** Native options never override core policy; only the returned version-checked edit enters the editor. */
test('document and range providers delegate native facts, excluding protected views', async t => {
  const f = fixture(t), token = { isCancellationRequested: false, onCancellationRequested: () => ({ dispose() {} }) };
  assert.equal(f.providers.selector.some(selector => selector.scheme === 'eska-protected'), false);
  const edits = await f.providers.document.provideDocumentFormattingEdits(f.document, { tabSize: 13, insertSpaces: true }, token);
  assert.equal(edits[0].newText, 'Value = 1;\n');
  assert.equal(f.params[0].userReadOnly, false); assert.equal(f.params[0].style, undefined); assert.equal(f.params[0].tabSize, undefined);
  await f.providers.range.provideDocumentRangeFormattingEdits(f.document, { start: { character: 2 }, end: { character: 4 } }, {}, token);
  assert.deepEqual(JSON.parse(JSON.stringify(f.params[1].range)), { start: 2, end: 4 });
  f.document.uri.scheme = 'eska-protected'; assert.equal((await f.providers.document.provideDocumentFormattingEdits(f.document, {}, token)).length, 0);
});

/** Late responses cannot format a changed/closed document, a read-only view, or a cancelled request. */
test('formatting suppresses obsolete native edits and save formatting requires explicit opt-in', async t => {
  const f = fixture(t), entered = barrier(), held = barrier(); f.pending = async () => { entered.release(); await held.promise; };
  const job = f.providers.document.provideDocumentFormattingEdits(f.document, {}, { isCancellationRequested: false, onCancellationRequested: () => ({ dispose() {} }) });
  await entered.promise; f.document.version++; f.handlers.change({ document: f.document, contentChanges: [{}] }); held.release(); assert.equal((await job).length, 0);
  f.pending = async () => {}; f.readonly = true;
  assert.equal((await f.providers.document.provideDocumentFormattingEdits(f.document, {}, { isCancellationRequested: false, onCancellationRequested: () => ({ dispose() {} }) })).length, 0);
  let saved; f.handlers.save({ document: f.document, waitUntil: promise => { saved = promise; } }); assert.equal(saved, undefined);
  f.readonly = false; f.settings['eska.explorer.formatOnSave'] = true;
  f.handlers.save({ document: f.document, waitUntil: promise => { saved = promise; } }); assert.equal((await saved).length, 1);
  saved = undefined; f.settings['editor.formatOnSave'] = true;
  f.handlers.save({ document: f.document, waitUntil: promise => { saved = promise; } }); assert.equal(saved, undefined);
  assert.equal(f.warnings.length, 0);
});

/** Query drafts use their source-owning session, never a metadata-free replacement server. */
test('query formatting delegates to the current source session without starting another backend', async t => {
  const f = fixture(t); f.document.uri.scheme = 'eska-query'; f.document.languageId = 'sdbl';
  const edits = await f.providers.document.provideDocumentFormattingEdits(f.document, {}, { isCancellationRequested: false, onCancellationRequested: () => ({ dispose() {} }) });
  assert.equal(edits.length, 1); assert.equal(f.calls[0], 'query'); assert.equal(f.projectCalls, 0);
});
