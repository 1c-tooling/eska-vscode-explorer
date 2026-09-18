import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm, readFile, symlink } from "node:fs/promises";
import { resolve, join, isAbsolute } from "node:path";
import { Connection } from "../out/connection.js";
import { MetadataTree, nodeKey, parseNode } from "../out/tree.js";
import { nativePath, editorRange, existingSource, resolveSource, isCommonModule } from "../out/source.js";
import { createTreeProject, descriptor, inline, addCommonModules } from "./fixture.mjs";

const executable = process.env.ESKA_TEST_BINARY;
/** Get a backend label without imposing a client-side kind catalog. */
function label(entry) { const value = entry.node.label; return value.kind === "name" ? value.text : value.translations["ru-RU"]; }
/** Locate a single intended sibling and provide useful failure context. */
function named(entries, name) { const found = entries.find((entry) => label(entry) === name); assert.ok(found, `${name}: ${entries.map(label)}`); return found; }

test("native paths and UTF-8 byte ranges never lose characters", () => {
  assert.equal(nativePath({ value: "100%файл.xml", encoding: "utf-8" }), "100%файл.xml");
  assert.throws(() => nativePath({ value: "%FF", encoding: "percent" }), { code: "unsupportedPath" });
  assert.throws(() => nativePath({ value: "bad\ud800", encoding: "utf-8" }), { code: "unsupportedPath" });
  const text = '\ufeff😀\r\n<Name>Артикул</Name>';
  const bytes = Buffer.from(text);
  const start = Buffer.byteLength('\ufeff😀\r\n');
  const range = editorRange(bytes, start, bytes.length);
  assert.equal(range.text.slice(range.start, range.end), '<Name>Артикул</Name>');
  assert.equal(range.start, 4);
  assert.throws(() => editorRange(bytes, 4, 6), { code: "sourceChanged" });
});

test("opaque node identities are independent of JSON property order", () => {
  assert.equal(nodeKey({ kind: "module", owner: "opaque/a.b", role: "object" }),
    nodeKey({ role: "object", owner: "opaque/a.b", kind: "module" }));
  assert.throws(() => parseNode({ id: { kind: "collection", collection: null } }), { code: "protocolInvalid" });
});

test("real backend lazy trees, source positions and local invalidation for all four schemas", { skip: !executable }, async (t) => {
  const playground = process.env.ESKA_TEST_ROOT ?? resolve("../eska-playground");
  assert.ok(isAbsolute(playground) && isAbsolute(executable));
  const root = await mkdtemp(join(playground, "explorer-tree-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const connection = new Connection("0.0.0", () => {}, () => {});
  t.after(() => connection.dispose());
  for (const type of ["configuration", "extension", "processing", "report"]) {
    const fixture = await createTreeProject(join(root, type), type);
    await connection.connect({ executable, path: fixture.root, name: "test", locale: "ru-RU" });
    assert.equal(connection.state.kind, "ready");
    const updates = [];
    const tree = new MetadataTree(connection, connection.state.session, (entries) => updates.push(entries), () => {});
    const [top] = await tree.roots();
    let object = top;
    let sibling;
    if (type === "configuration" || type === "extension") {
      const catalog = named(await tree.children(top), "Справочники");
      const objects = await tree.children(catalog);
      object = named(objects, "Товары");
      sibling = named(objects, "Покупатели");
      assert.equal(object.children, undefined, "descriptors are not expanded by listing objects");
      await tree.children(sibling);
    }
    const groups = await tree.children(object);
    assert.equal(label(groups[0]), "Модули");
    assert.equal(groups[0].node.expandedByDefault, true);
    const modules = await tree.children(groups[0]);
    assert.equal(modules.length, 1, "binary-only manager module is hidden");
    assert.equal((await resolveSource(tree, modules[0])).path, fixture.module);
    const attributeGroup = named(groups, "Реквизиты");
    const attribute = named(await tree.children(attributeGroup), "Артикул");
    const location = await resolveSource(tree, attribute);
    assert.equal(location.path, fixture.descriptor);
    assert.equal(location.position.text.slice(location.position.start, location.position.end), "<Name>Артикул</Name>");
    const sections = await tree.children(named(groups, "Табличные части"));
    const sectionChildren = await tree.children(named(sections, "Строки"));
    assert.ok(sectionChildren.length);
    const siblingChildren = sibling?.children;
    const oldKey = object.key;
    const original = await readFile(fixture.descriptor, "utf8");
    await writeFile(fixture.descriptor, original.replace("<Name>Артикул</Name>", "<Name>НовыйАртикул</Name>"));
    connection.notify(tree.session.sessionId, "workspace/didChangeFiles", { projectId: object.project.info.projectId,
      sequence: "1", paths: [{ value: type === "configuration" || type === "extension" ? "Catalogs/Товары.xml" : "Тест.xml", encoding: "utf-8" }] });
    await connection.request(tree.session.sessionId, "project/info");
    const changedGroups = await tree.children(object);
    named(await tree.children(named(changedGroups, "Реквизиты")), "НовыйАртикул");
    assert.equal(object.key, oldKey);
    if (sibling) assert.equal(sibling.children, siblingChildren, "unrelated branch cache is retained");
    assert.ok(updates.length);
    if (sibling) {
      await writeFile(fixture.descriptor, "<broken");
      await tree.refresh(object.project, object);
      await assert.rejects(tree.children(object));
      assert.equal(sibling.children, siblingChildren);
      await writeFile(fixture.descriptor, descriptor("Catalog", "Товары", inline()));
      await tree.refresh(object.project, object);
      named(await tree.children(object), "Реквизиты");
    }
    await assert.rejects(existingSource(object.project.info.sourcePath, { value: "../eska.toml", encoding: "utf-8" }), { code: "sourceMissing" });
    const outside = join(fixture.root, "outside.xml");
    await writeFile(outside, "outside");
    await symlink(outside, join(fixture.source, "escape.xml"));
    await assert.rejects(existingSource(object.project.info.sourcePath, { value: "escape.xml", encoding: "utf-8" }), { code: "sourceMissing" });
    tree.dispose();
  }
});

test("an invalidated in-flight expansion retries; older and gapped notifications cannot revive a cache", async () => {
  const info = { projectId: 'p', scope: { kind: 'standalone' }, type: 'configuration',
    rootPath: { value: '/project', encoding: 'utf-8' }, sourcePath: { value: '/project/src', encoding: 'utf-8' },
    root: { kind: 'object', objectId: 'opaque-root' }, generation: '0', eventSequence: '0', requiresRefresh: false, requiresReopen: false };
  const rootNode = { id: info.root, parent: null, label: { kind: 'name', text: 'Test' }, state: 'unloaded', expandedByDefault: false, rootSection: false };
  let notify;
  let release;
  let reads = 0;
  const recoveries = [];
  const responses = (generation, eventSequence, fields) => ({ sessionId: 's', projectId: 'p', generation, eventSequence, ...fields });
  const connection = {
    onNotification(listener) { notify = listener; return { dispose() {} }; },
    async request(_session, method) {
      if (method === 'metadata/root') return responses('0', '0', { node: rootNode });
      reads++;
      if (reads === 1) return new Promise(resolve => { release = resolve; });
      return responses('1', '1', { nodes: [] });
    },
  };
  const tree = new MetadataTree(connection, { sessionId: 's', projects: [info] }, () => {}, (...args) => recoveries.push(args));
  const [root] = await tree.roots();
  const pending = tree.children(root);
  assert.equal(tree.children(root), pending, 'concurrent expansion uses a single request');
  notify('metadata/changed', responses('1', '1', { affected: ['opaque-root'], requiresRefresh: false, requiresReopen: false }));
  release(responses('0', '0', { nodes: [{ ...rootNode, id: { kind: 'object', objectId: 'obsolete' }, parent: info.root }] }));
  assert.deepEqual(await pending, [], 'old response must not resurrect obsolete objects');
  assert.equal(reads, 2);
  const cached = root.children;
  notify('metadata/changed', responses('0', '0', { affected: null, requiresRefresh: false, requiresReopen: false }));
  assert.equal(root.children, cached, 'old event cannot invalidate or regress tokens');
  notify('metadata/changed', responses('1', '3', { affected: [], requiresRefresh: false, requiresReopen: false }));
  assert.equal(root.children, undefined, 'event gap invalidates even at the same generation');
  assert.equal(recoveries.length, 1);
  tree.dispose();
});

test("common modules open existing BSL directly and retain explicit XML access", { skip: !executable }, async (t) => {
  const root = await mkdtemp(join(process.env.ESKA_TEST_ROOT ?? resolve("../eska-playground"), "explorer-common-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const fixture = await createTreeProject(root);
  await addCommonModules(fixture);
  const connection = new Connection("0.0.0", () => {}, () => {});
  t.after(() => connection.dispose());
  await connection.connect({ executable, path: root, name: "test", locale: "ru-RU" });
  assert.equal(connection.state.kind, "ready");
  const tree = new MetadataTree(connection, connection.state.session, () => {}, () => {});
  t.after(() => tree.dispose());
  const [top] = await tree.roots();
  const common = named(await tree.children(top), "Общие");
  const group = named(await tree.children(common), "Общие модули");
  const entries = await tree.children(group);
  const module = named(entries, "Обмен");
  assert.ok(isCommonModule(module));
  assert.equal(isCommonModule(group), false);
  assert.equal((await resolveSource(tree, module)).path, join(fixture.source, "CommonModules", "Обмен", "Ext", "Module.bsl"));
  assert.equal(module.children, undefined, "opening BSL does not load hidden module groups");
  const xml = await resolveSource(tree, module, "xml");
  assert.equal(xml.path, join(fixture.source, "CommonModules", "Обмен.xml"));
  assert.equal(xml.position.text.slice(xml.position.start, xml.position.end), "<Name>Обмен</Name>");
  const binary = named(entries, "Защищенный");
  await assert.rejects(resolveSource(tree, binary), { code: "sourceMissing" });
  assert.equal((await resolveSource(tree, binary, "xml")).path, join(fixture.source, "CommonModules", "Защищенный.xml"));
});
