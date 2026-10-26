import { test } from 'node:test';
import assert from 'node:assert/strict';
import { layoutPreferences, moveDivider } from '../resources/query/layout.mjs';

/** Corrupt or stale webview storage must not hide panes or retain a canonical source document. */
test('layout storage rejects invalid dimensions and retains presentation fields only', () => {
  const state = layoutPreferences({ version: 1, text: 'SELECT private text', previewHeight: Infinity,
    widths: { 2: [0, 1], 3: [.1, .9, .9] }, page: { 0: 'order', 1: 'unknown', inherited: 'fields' },
    views: { '0:order': { scroll: { valid: 40, invalid: -1 }, details: { visible: true, invalid: 'true' } } },
    extra: ['totals', 'totals', 'unknown'], expanded: ['Catalog.Товары', null, 'x'.repeat(513)] });
  assert.equal(state.text, undefined);
  assert.deepEqual(state.page, { 0: 'order' });
  assert.deepEqual(state.widths, { 2: [.5, .5], 3: [1/3, 1/3, 1/3] });
  assert.equal(state.previewHeight, 180);
  assert.deepEqual(state.views['0:order'], { scroll: { valid: 40 }, details: { visible: true } });
  assert.deepEqual(state.extra, ['totals']); assert.deepEqual(state.expanded, ['Catalog.Товары']);
});

/** Pointer and keyboard adjustments cannot remove an adjacent pane or resize an unrelated one. */
test('divider adjustments preserve total width and clamp each adjacent pane', () => {
  for (const change of [-100, -.1, 0, .1, 100]) {
    const original = [.2, .3, .5], next = moveDivider(original, 1, change);
    assert.deepEqual(original, [.2, .3, .5]); assert.equal(next[0], .2);
    assert.ok(Math.abs(next.reduce((a,b) => a+b) - 1) < 1e-12);
    assert.ok(next[1] >= .1 - 1e-12 && next[2] >= .1 - 1e-12);
  }
});
