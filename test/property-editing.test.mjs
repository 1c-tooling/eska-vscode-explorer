import { test } from 'node:test';
import assert from 'node:assert/strict';
import { editingSchema, propertyChange } from '../out/property-editing.js';

/** A real schema envelope keeps field validation separate from transport errors. */
function envelope(schema) {
  return { snapshot: 'a'.repeat(64), source: { value: 'HTTPServices/Age.xml', encoding: 'utf-8' },
    writable: true, undo: false, redo: false, fields: [{
      path: [{ key: { name: 'SessionMaxAge', namespace: 'http://v8.1c.ru/8.3/MDClasses' }, occurrence: 0 }],
      value: '9007199254740993', language: null, captions: [], schema,
    }] };
}

test('unsigned integer bounds and user changes retain exact decimal strings', () => {
  const source = envelope({ kind: 'unsignedInteger', min: '0', max: '18446744073709551615' });
  const parsed = editingSchema(JSON.parse(JSON.stringify(source)));
  assert.deepEqual(parsed, source);
  assert.deepEqual(propertyChange({ kind: 'text', value: '18446744073709551615' }, parsed.fields[0]),
    { kind: 'text', value: '18446744073709551615' });
  assert.equal(propertyChange({ kind: 'text', value: Number('18446744073709551615') }, parsed.fields[0]), undefined);
});

test('integer schema rejects rounded, malformed and reversed bounds before showing an editor', () => {
  for (const schema of [
    { kind: 'integer', min: 0, max: 9007199254740992 },
    { kind: 'integer', min: 10, max: 2 },
    { kind: 'unsignedInteger', min: '0', max: 18446744073709551615 },
    { kind: 'unsignedInteger', min: '0', max: '18446744073709551616' },
    { kind: 'unsignedInteger', min: '-1', max: '20' },
    { kind: 'unsignedInteger', min: '10', max: '2' },
    { kind: 'unsignedInteger', min: '0', max: '1e20' },
    { kind: 'unsignedInteger', min: '0', max: '020' },
  ]) assert.throws(() => editingSchema(envelope(schema)), { code: 'protocolInvalid' });
  assert.doesNotThrow(() => editingSchema(envelope({ kind: 'integer', min: 0, max: 628 })));
});
