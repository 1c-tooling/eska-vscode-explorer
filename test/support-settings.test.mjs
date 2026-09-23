import { test } from 'node:test';
import assert from 'node:assert/strict';
import { reconcileRules, readonlyPattern, readonlyPatterns } from '../out/support-settings.js';

test('support restrictions preserve user rules and remove only owned entries', () => {
  const user = { '**/*.bsl': true, '**/*.os': true, 'custom': false };
  const first = reconcileRules(user, [], ['/project/src/Module.bsl']);
  assert.deepEqual(first.owned, ['/project/src/Module.bsl']);
  assert.deepEqual(reconcileRules(first.rules, first.owned, []).rules, user);
  assert.deepEqual(reconcileRules(user, [], ['**/*.bsl']).owned, []);
  const changed = { ...first.rules, '/project/src/Module.bsl': false };
  assert.deepEqual(reconcileRules(changed, first.owned, []).rules, changed);
  assert.deepEqual(reconcileRules(first.rules, first.owned, first.owned), first);
});
test('source paths are literal and project-specific', () => {
  assert.equal(readonlyPattern('/one/a[b]*?.bsl'), '/one/a[[]b[]][*][?].bsl');
  assert.equal(readonlyPattern('C:\\one\\Module.bsl'), 'C:/one/Module.bsl');
});

test('large policy has bounded keys and literal project-scoped alternatives', () => {
  const paths = Array.from({length: 1000}, (_, i) => `/project/src/CommonModules/M${i}/Ext/Module.bsl`);
  const patterns = readonlyPatterns('/project/src', paths);
  assert.equal(patterns.length, 8);
  assert.ok(patterns.every(pattern => pattern.startsWith('/project/src/CommonModules/M')));
  assert.deepEqual(readonlyPatterns('/project/src', [...paths].reverse()), patterns);
  assert.equal(readonlyPattern('/src/a,b.bsl'), '/src/a[,]b.bsl');
});


test('factoring shared literals retains the exact file set and reduces pattern size', () => {
  const paths = Array.from({length: 256}, (_, i) => `/project/src/CommonModules/M${i}/Ext/Module.bsl`);
  const patterns = readonlyPatterns('/project/src', paths);
  assert.ok(patterns.join('').length < paths.join('').length / 3);
  assert.ok(patterns.every(pattern => pattern.endsWith('}/Ext/Module.bsl')));
  const different = [...paths, '/project/src/Catalogs/A/Ext/ObjectModule.bsl', '/project/src/Catalogs/B/Ext/ManagerModule.bsl'];
  const expanded = readonlyPatterns('/project/src', different).flatMap(pattern => {
    const match = /^([^{}]*)\{([^{}]*)\}([^{}]*)$/.exec(pattern);
    return match ? match[2].split(',').map(value => match[1] + value + match[3]) : [pattern];
  });
  assert.deepEqual(expanded.sort(), different.sort());
});
