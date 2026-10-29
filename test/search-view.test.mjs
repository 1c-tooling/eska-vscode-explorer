import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

/** Keep native selection events independent of result repainting, as in the extension-host bridge. */
function fixture() {
  const listeners = new Map(), navigated = [], requests = [];
  const event = name => listener => { listeners.set(name, listener); return { dispose() { listeners.delete(name); } }; };
  const picker = { items: [], activeItems: [], selectedItems: [], value: '',
    onDidChangeValue: event('change'), onDidTriggerButton: event('button'), onDidAccept: event('accept'),
    onDidHide: event('hide'), show() {}, dispose() {} };
  const vscode = { window: { createQuickPick: () => picker }, env: { language: 'en' },
    ThemeIcon: class {}, QuickPickItemKind: { Separator: -1 } };
  const rootId = { kind: 'object', objectId: 'root' }, node = { kind: 'object', objectId: 'item' };
  const project = { key: 'project', info: { scope: { kind: 'standalone' }, type: 'configuration', root: rootId, generation: '1' } };
  const target = { project, node: { id: node } }, root = { project, node: { id: rootId } };
  const tree = { connection: { target: { name: 'Project' } },
    async request(_project, method) { requests.push(method); return { ancestry: [rootId, node], generation: '1' }; },
    async root() { return root; }, async children() { return [target]; } };
  const require = createRequire(new URL('../out/search-view.js', import.meta.url)), adapter = { exports: {} };
  const search = require('./search.js');
  class Session { snapshot = { text: 'Item', loading: false, projects: [] }; setText() {} dispose() {} }
  runInNewContext(`(function(require,module,exports){${readFileSync(new URL('../out/search-view.js', import.meta.url), 'utf8')}\n})`, { AbortController })(
    name => name === 'vscode' ? vscode : name === './search.js' ? { ...search, SearchSession: Session } : require(name), adapter, adapter.exports);
  const view = new adapter.exports.SearchView(tree, () => 'en-US', async entry => { navigated.push(entry); }, () => {});
  const snapshot = { text: 'Item', loading: false, projects: [{ project, hits: [{ objectId: 'item', node,
    name: 'Item', metadataKind: 'catalog', synonyms: [], ancestry: [rootId, node] }] }] };
  return { view, picker, snapshot, navigated, requests, target };
}

test('clicking a result after an index repaint resolves its stable identity and revalidates ancestry', async () => {
  const f = fixture();
  f.view.render(f.snapshot);
  f.picker.selectedItems = [f.picker.items.find(item => item.hit)];
  f.view.render(f.snapshot);
  assert.ok(!f.picker.items.includes(f.picker.selectedItems[0]), 'the selection event refers to the previous rendering');
  await f.view.accept();
  assert.deepEqual(f.requests, ['metadata/reveal']);
  assert.deepEqual(f.navigated, [f.target]);
  assert.equal(f.view.disposed, true);
});

test('a removed selection cannot silently navigate to a different active result', async () => {
  const f = fixture();
  f.view.render(f.snapshot);
  f.picker.selectedItems = [{ ...f.picker.items.find(item => item.hit), identity: 'removed' }];
  await f.view.accept();
  assert.deepEqual(f.requests, []);
  assert.deepEqual(f.navigated, []);
  f.view.dispose();
});
