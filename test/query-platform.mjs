import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { Connection } from '../out/connection.js';
import { MetadataTree } from '../out/tree.js';
import { revealFile } from '../out/reveal.js';
import { QueryClient, querySnapshot } from '../out/query/client.js';
import { QueryRecovery } from '../out/query/recovery.js';
import { QuerySessions } from '../out/query/sessions.js';

/** Apply only ESKA's byte ranges and verify the entire native result before its receipt. */
function apply(input, plan) {
  let bytes = Buffer.from(input);
  for (const edit of [...plan.replacements].reverse()) bytes = Buffer.concat([bytes.subarray(0, edit.range.start), Buffer.from(edit.text), bytes.subarray(edit.range.end)]);
  const text = bytes.toString(); assert.equal(querySnapshot(text), plan.outputSnapshot); return text;
}

/** Native facts carry exact versions and bytes; no IDE-specific state enters the core model. */
function facts(version, text) { return { version: String(version), snapshot: querySnapshot(text), isDirty: true, userReadOnly: false, application: null }; }

/** Three platform-created source kinds share one constructor, checkpoint queue and source-application contract. */
async function edit(binary, root, locale, number) {
  const c = new Connection('t105-platform', () => {}, () => {}); let tree, store;
  try {
    await c.connect({ executable: binary, path: root, name: 'platform queries', locale });
    const state = c.state; assert.equal(state.kind, 'ready', JSON.stringify(state));
    tree = new MetadataTree(c, state.session, () => {}, () => {});
    const project = tree.projects[0]; store = new QueryRecovery(c.recovery, join(dirname(root), 'private-' + locale), () => assert.fail('valid checkpoint'));
    await store.records(); const sessions = new QuerySessions(c.recovery, store, () => ({ sessionId: state.session.sessionId, projectId: project.info.projectId, generation: project.info.generation }), state.queryEditing);
    const rows = [];
    for (const sourcePath of ['CommonTemplates/QuerySchema/Ext/Template.xml', 'CommonForms/QueryLists/Ext/Form.xml', 'CommonModules/QueryBSL/Ext/Module.bsl']) {
      const file = join(root, 'src', sourcePath), original = await readFile(file, 'utf8'), revealed = await revealFile(tree, file);
      assert.ok(revealed); const entry = 'target' in revealed ? revealed.owner : revealed;
      const doc = await new QueryClient(c, state.session.sessionId, project, state.queryEditing).open({ node: entry.node.id,
        source: { value: sourcePath, encoding: 'utf-8' }, version: '7', text: original });
      assert.equal(doc.writable, true, sourcePath);
      const offset = original.indexOf('SELECT ') + 3, line = original.slice(0, offset).split('\n').length - 1;
      const selected = sourcePath.endsWith('.bsl') ? await doc.read({ at: { line, character: offset - original.lastIndexOf('\n', offset) - 1 } }) : (await doc.list())[0];
      const session = await sessions.open(doc, randomUUID(), selected.identity, false); await doc.close();
      const constructor = await session.openConstructor(), draft = session.record.draft;
      await constructor.action({ kind: 'replace', selection: { statement: 0, clause: 0, item: 0 }, text: `${number} AS N` });
      const draftPlan = await constructor.plan(querySnapshot(draft)), result = apply(draft, draftPlan);
      assert.equal(await readFile(file, 'utf8'), original, 'constructor never writes an owner');
      await constructor.finish(querySnapshot(draft), querySnapshot(result));
      const plan = await session.prepare(facts(7, original), result, [], 'crlf'), output = apply(original, plan);
      assert.equal(plan.saveOwner, false); await session.applied(plan.applyToken, facts(8, output));
      assert.equal(await readFile(file, 'utf8'), original, 'RPC never writes a native buffer or source');
      await session.close(); await store.remove(session.record.id, true);
      await writeFile(file, output); rows.push({ source: sourcePath, query: result, sourceSha256: querySnapshot(output), replacements: plan.replacements.length,
        preservedBom: original.startsWith('\ufeff') && output.startsWith('\ufeff'), crlfOnly: !output.replaceAll('\r\n', '').includes('\n') });
    }
    return { locale, rows };
  } finally { await store?.settled(); tree?.dispose(); await c.dispose(); }
}

const [binary, root] = process.argv.slice(2).map(value => resolve(value));
assert.ok(binary && root && JSON.parse(await readFile(join(dirname(root), 'owner.json'), 'utf8')).task === 'T105');
const results = [];
for (const [locale, number] of [['en-US', 21], ['ru-RU', 31]]) results.push(await edit(binary, root, locale, number));
await writeFile(join(dirname(root), 'rpc-result.json'), JSON.stringify({ passed: true, results }, null, 2) + '\n');
console.log(JSON.stringify({ passed: true, sources: 3, locales: 2 }));
