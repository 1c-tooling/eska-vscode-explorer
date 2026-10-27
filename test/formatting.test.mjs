import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { formatCapabilities, formatEdits, withFormatText } from '../out/formatting/protocol.js';
import { FormattingBackend } from '../out/formatting/backend.js';

/** Build protocol replies with coordinates anchored to the submitted native snapshot. */
function reply(text, edits, version = 1) {
  return { schemaVersion: 1, version: String(version), plan: { schema_version: 1,
    source_sha256: createHash('sha256').update(text).digest('hex'), formatted_range: { start: 0, end: Buffer.byteLength(text) }, edits } };
}

/** Capabilities cannot authorize source writes, enable silent save formatting or enlarge local bounds. */
test('formatter capability requires API 1.33 and an independent plan-only component', () => {
  const value = { apiVersion: { major: 1, minor: 33 }, capabilities: { formatting: { schemaVersion: 1, component: 'eska-fmt', protocolVersion: 1,
    planOnly: true, writesOwner: false, languages: ['bsl', 'sdbl'], document: true, range: true, queryDraft: true,
    formatOnSave: 'opt_in', maxTextBytes: 8_388_608, maxInlineBytes: 262_144 } } };
  assert.deepEqual(formatCapabilities(value), { maxTextBytes: 4_194_304, maxInlineBytes: 131_072 });
  for (const broken of [v => v.apiVersion.minor = 32, v => v.capabilities.formatting.writesOwner = true,
    v => v.capabilities.formatting.component = 'bsl-analyzer', v => v.capabilities.formatting.formatOnSave = true]) {
    const bad = structuredClone(value); broken(bad); assert.throws(() => formatCapabilities(bad));
  }
  assert.equal(formatCapabilities({ capabilities: {} }), undefined);
});

/** The adapter converts transport coordinates only; it never computes formatting or guesses invalid Unicode boundaries. */
test('UTF-8 formatter edits map BOM, CRLF, Cyrillic and supplementary Unicode into native offsets', () => {
  const text = '\ufeff// 😀\r\nПеременная=1;\r\n', prefix = text.indexOf('=');
  const start = Buffer.byteLength(text.slice(0, prefix));
  assert.deepEqual(formatEdits(reply(text, [{ range: { start, end: start + 1 }, text: ' = ' }]), text, 1), [{ start: prefix, end: prefix + 1, text: ' = ' }]);
  const valid = reply(text, [{ range: { start, end: start + 1 }, text: ' = ' }]);
  for (const broken of [v => v.version = '2', v => v.plan.source_sha256 = '0'.repeat(64),
    v => v.plan.edits[0].range.start = 1, v => v.plan.edits.push(v.plan.edits[0]),
    v => v.plan.formatted_range.end--, v => v.plan.edits[0].text = '\ud800']) {
    const bad = structuredClone(valid); broken(bad);
    // The shortened formatted range still contains the edit and is legal; force it to split a Cyrillic codepoint instead.
    if (bad.plan.formatted_range.end === Buffer.byteLength(text) - 1) bad.plan.formatted_range.end = start - 1;
    assert.throws(() => formatEdits(bad, text, 1));
  }
});

const binary = process.env.ESKA_TEST_BINARY, formatter = process.env.ESKA_TEST_FMT_BINARY;
/** A real text-only process serves dirty native text without workspace/open, metadata indexing or analyzer installation. */
test('real backend formats standalone native buffers and releases chunk uploads without disk writes', { skip: !binary || !formatter }, async t => {
  const root = await mkdtemp(join(process.env.ESKA_TEST_ROOT ?? resolve('../eska-playground'), 'explorer-format-'));
  const backend = new FormattingBackend('formatter-integration', () => {});
  t.after(async () => { await backend.shutdown(); await rm(root, { recursive: true, force: true }); });
  const path = join(root, 'module.bsl'), original = 'Value=1;\n'; await writeFile(path, original);
  const endpoint = await backend.endpoint(binary, root, 'en-US');
  const text = 'Процедура Test()\r\nЗначение=2;\r\nКонецПроцедуры\r\n';
  const params = { source: { value: path, encoding: 'utf-8' }, formatter: { value: formatter, encoding: 'utf-8' }, version: '1', userReadOnly: false };
  const formatted = await withFormatText(endpoint, text, input => endpoint.request('format/document', { ...params, ...input }));
  let result = text;
  for (const edit of formatEdits(formatted, text, 1).reverse()) result = result.slice(0, edit.start) + edit.text + result.slice(edit.end);
  assert.equal(result, 'Процедура Test()\r\n\tЗначение = 2;\r\nКонецПроцедуры\r\n');
  assert.deepEqual(formatted.effective.origins, (await withFormatText(endpoint, text, input => endpoint.request('format/document', { ...params, ...input }))).effective.origins);
  assert.equal(await readFile(path, 'utf8'), original);
  await assert.rejects(endpoint.request('format/document', { ...params, text, userReadOnly: true }), error => error.domain === 'formatting_failed' && error.details.code === 'source_read_only');
  const large = '// ' + 'д'.repeat(80_000) + '\n' + text;
  for (let attempt = 0; attempt < 2; attempt++) {
    const plan = await withFormatText(endpoint, large, input => endpoint.request('format/document', { ...params, ...input }));
    assert.ok(formatEdits(plan, large, 1).length);
  }
  await backend.stop();
  await assert.rejects(endpoint.request('format/document', { ...params, text }), error => error.code === 'obsolete');
  const reopened = await backend.endpoint(binary, root, 'ru-RU');
  assert.deepEqual((await reopened.request('format/document', { ...params, text })).plan, formatted.plan);
});
