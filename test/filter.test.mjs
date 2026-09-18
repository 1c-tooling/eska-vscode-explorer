import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { resolve, join } from "node:path";
import { ProjectFilters, isHiddenSection, supportsRootFilter } from "../out/filter.js";
import { Connection } from "../out/connection.js";
import { MetadataTree } from "../out/tree.js";
import { createTreeProject, addCommonModules } from "./fixture.mjs";

/** Model editor workspace storage while preserving actual per-key persistence semantics. */
function storage() {
  const data = new Map();
  return { get: key => data.get(key), async update(key, value) {
    if (value === undefined) data.delete(key); else data.set(key, value);
  } };
}
/** Read supplied labels without inferring schema from IDs. */
function label(entry) { return entry.node.label.kind === "name" ? entry.node.label.text : entry.node.label.translations["ru-RU"]; }
/** Fail with available labels when the intended group is missing. */
function named(entries, name) { const entry = entries.find(entry => label(entry) === name); assert.ok(entry, `${name}: ${entries.map(label)}`); return entry; }

test("project filter choices persist separately and reset to the current configured default", async () => {
  const state = storage();
  let filters = new ProjectFilters(state);
  const first = { key: "first" }, second = { key: "second" };
  assert.equal(filters.enabled(first, true), true);
  assert.equal(filters.enabled(first, false), false);
  await filters.set(first, false);
  await filters.set(second, true);
  filters = new ProjectFilters(state);
  assert.equal(filters.enabled(first, true), false);
  assert.equal(filters.enabled(second, false), true);
  await filters.set(first, undefined);
  assert.equal(filters.enabled(first, true), true);
  assert.equal(filters.enabled(first, false), false);
  assert.equal(filters.enabled(second, false), true);
});

test("only proven empty root and immediate Common sections are hidden", () => {
  const root = { kind: "object", objectId: "opaque:root" };
  const common = { kind: "collection", owner: root.objectId, collection: { kind: "common" } };
  const metadata = { kind: "collection", owner: root.objectId, collection: { kind: "metadata", metadataKind: "role" } };
  const cases = [
    { id: root, parent: null, rootSection: false, eligible: false },
    { id: common, parent: root, rootSection: true, eligible: true },
    { id: metadata, parent: root, rootSection: true, eligible: true },
    { id: metadata, parent: common, rootSection: false, eligible: true },
    { id: metadata, parent: root, rootSection: false, eligible: false },
    { id: metadata, parent: metadata, rootSection: false, eligible: false },
    { id: metadata, parent: { ...common, owner: "other" }, rootSection: false, eligible: false },
    { id: { ...metadata, collection: { kind: "unsupported" } }, parent: common, rootSection: false, eligible: false },
    { id: root, parent: common, rootSection: false, eligible: false },
    { id: { kind: "module", owner: root.objectId, role: "manager" }, parent: common, rootSection: false, eligible: false },
  ];
  for (const type of ["configuration", "extension", "report", "processing"]) {
    const project = { info: { type } };
    assert.equal(supportsRootFilter(project), ["configuration", "extension"].includes(type));
    for (const state of ["empty", "non_empty", "unloaded", "error"]) {
      for (const { eligible, ...node } of cases) {
        const entry = { project, node: { ...node, state } };
        assert.equal(isHiddenSection(entry, true), supportsRootFilter(project) && eligible && state === "empty", JSON.stringify(entry));
        assert.equal(isHiddenSection(entry, false), false);
      }
    }
  }
});

const executable = process.env.ESKA_TEST_BINARY;
test("real filters hide empty Common sections, retain object groups and reuse cached children", { skip: !executable }, async t => {
  const root = await mkdtemp(join(process.env.ESKA_TEST_ROOT ?? resolve("../eska-playground"), "explorer-filter-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const connection = new Connection("test", () => {}, () => {});
  t.after(() => connection.dispose());
  for (const type of ["configuration", "extension", "report", "processing"]) {
    const fixture = await createTreeProject(join(root, type), type);
    if (["configuration", "extension"].includes(type)) {
      await addCommonModules(fixture);
      await mkdir(join(fixture.source, "Ext"), { recursive: true });
      await writeFile(join(fixture.source, "Ext", "SessionModule.bin"), "binary only");
    }
    await connection.connect({ executable, path: fixture.root, name: type, locale: "ru-RU" });
    assert.equal(connection.state.kind, "ready", JSON.stringify(connection.state));
    const tree = new MetadataTree(connection, connection.state.session, () => {}, () => {});
    const [top] = await tree.roots();
    const all = await tree.children(top);
    const generation = top.project.info.generation;
    const shown = all.filter(entry => !isHiddenSection(entry, true));
    assert.equal(await tree.children(top), all, "the complete children stay cached across view filtering");
    assert.equal(top.project.info.generation, generation);
    if (supportsRootFilter(top.project)) {
      assert.equal(named(all, "Константы").node.state, "empty");
      assert.ok(!shown.some(entry => label(entry) === "Константы"));
      assert.ok(!all.some(entry => label(entry) === "Модули"), "binary-only root has no module group even with the filter off");
      const common = named(shown, "Общие");
      const commonChildren = await tree.children(common);
      assert.equal(named(commonChildren, "Роли").node.state, "empty");
      assert.deepEqual(commonChildren.filter(entry => !isHiddenSection(entry, true)).map(label), ["Общие модули"]);
      assert.deepEqual(commonChildren.filter(entry => !isHiddenSection(entry, false)), commonChildren);
      assert.equal(await tree.children(common), commonChildren, "Common sections stay cached across toggles");
      assert.equal(top.project.info.generation, generation);
      const catalogs = named(shown, "Справочники");
      const goods = named(await tree.children(catalogs), "Товары");
      const groups = await tree.children(goods);
      assert.equal(named(groups, "Формы").node.state, "empty");
      assert.ok(groups.every(entry => !isHiddenSection(entry, true)), "empty object collections stay visible");
      const rootFile = join(fixture.source, "Configuration.xml");
      const xml = await readFile(rootFile, "utf8");
      await writeFile(rootFile, xml.replace(/<Catalog>.*?<\/Catalog>/g, ""));
      await tree.refresh(top.project);
      await tree.root(top.project);
      const removed = await tree.children(top);
      assert.equal(isHiddenSection(named(removed, "Справочники"), true), true);
      await writeFile(rootFile, xml);
      await tree.refresh(top.project);
      await tree.root(top.project);
      assert.equal(isHiddenSection(named(await tree.children(top), "Справочники"), true), false);
    } else {
      assert.deepEqual(shown, all, "external sources are not filtered");
      assert.ok(named(all, "Формы"));
    }
    tree.dispose();
  }
});

test("workspace members retain independent filters after reconnect", { skip: !executable }, async t => {
  const root = await mkdtemp(join(process.env.ESKA_TEST_ROOT ?? resolve("../eska-playground"), "explorer-filters-workspace-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await createTreeProject(join(root, "first"));
  await createTreeProject(join(root, "second"), "extension");
  await writeFile(join(root, "eska.toml"), "[workspace]\nmembers=['first','second']\n");
  for (const [name, type] of [["first", "configuration"], ["second", "extension"]]) {
    await writeFile(join(root, name, "eska.toml"), `[project]\nname='${name}'\ntype='${type}'\n`);
  }
  const connection = new Connection("test", () => {}, () => {});
  t.after(() => connection.dispose());
  const filters = new ProjectFilters(storage());
  for (let run = 0; run < 2; run++) {
    await connection.connect({ executable, path: root, name: "workspace", locale: "ru-RU" });
    assert.equal(connection.state.kind, "ready", JSON.stringify(connection.state));
    const tree = new MetadataTree(connection, connection.state.session, () => {}, () => {});
    const roots = await tree.roots();
    assert.equal(roots.length, 2);
    const first = roots.find(entry => entry.project.info.scope.name === "first");
    const second = roots.find(entry => entry.project.info.scope.name === "second");
    if (run === 0) await filters.set(first.project, false);
    for (const entry of [first, second]) {
      const hide = filters.enabled(entry.project, true);
      assert.equal(hide, entry === second);
      const shown = (await tree.children(entry)).filter(child => !isHiddenSection(child, hide));
      assert.equal(shown.some(child => label(child) === "Константы"), entry === first);
    }
    tree.dispose();
  }
});
