import { deferCleanup } from "./cleanup.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { Connection } from "../out/connection.js";
import { MetadataTree, nodeKey } from "../out/tree.js";
import { revealFile, relativeFile } from "../out/reveal.js";
import { createTreeProject, addCommonModules } from "./fixture.mjs";

const executable = process.env.ESKA_TEST_BINARY;

/** Older backends cannot reintroduce a second ownership resolver in the adapter. */
test("reverse navigation requires the negotiated backend capability", async () => {
  const root = resolve("project");
  const tree = { projects: [{ info: { sourcePath: { value: root, encoding: "utf-8" } } }],
    connection: { state: { kind: "ready", sourceNavigation: false } },
    request() { assert.fail("unsupported navigation must not guess ownership or send a request"); } };
  await assert.rejects(revealFile(tree, join(root, "Catalogs", "Item.xml")), { code: "incompatible" });
});

test("file containment rejects sibling-prefix folders", () => {
  const root = resolve("project");
  assert.equal(relativeFile(root, join(root, "src", "a.bsl")), join("src", "a.bsl"));
  assert.equal(relativeFile(root, `${root}-other/a.bsl`), undefined);
});

/** Incomplete navigation paths must be removed when their owner disappears from a later complete listing. */
test("revealed paths are pruned and malformed ancestry cannot corrupt the tree", { skip: !executable }, async t => {
  const root = await mkdtemp(join(process.env.ESKA_TEST_ROOT ?? resolve("../eska-playground"), "explorer-reveal-prune-"));
  deferCleanup(t, () => rm(root, { recursive: true, force: true }));
  const fixture = await createTreeProject(join(root, "project"));
  const connection = new Connection("test", () => {}, () => {});
  deferCleanup(t, () => connection.dispose());
  await connection.connect({ executable, path: fixture.root, name: "test", locale: "en-US" });
  const tree = new MetadataTree(connection, connection.state.session, () => {}, () => {});
  deferCleanup(t, () => tree.dispose());
  const module = await revealFile(tree, fixture.module);
  const project = module.project, before = [...project.nodes];
  assert.throws(() => tree.acceptAncestry(project, [module.node]), { code: "protocolInvalid" });
  assert.throws(() => tree.acceptAncestry(project, [project.root.node, project.root.node]), { code: "protocolInvalid" });
  assert.deepEqual([...project.nodes], before);
  const descriptor = join(fixture.source, "Configuration.xml");
  await writeFile(descriptor, (await readFile(descriptor, "utf8")).replace("<Catalog>Товары</Catalog>", ""));
  await tree.refresh(project);
  const groups = await tree.children(await tree.root(project));
  const catalogs = groups.find(entry => entry.node.id.collection?.metadataKind === "catalog");
  await tree.children(catalogs);
  assert.equal(project.nodes.has(nodeKey(module.node.id)), false);
  await assert.rejects(tree.children(module), { code: "obsolete" });
  assert.equal(await revealFile(tree, fixture.module), undefined, "an existing file cannot revive a removed declaration");
});

test("reverse navigation resolves cold branches without a full search index", { skip: !executable }, async t => {
  const root = await mkdtemp(join(process.env.ESKA_TEST_ROOT ?? resolve("../eska-playground"), "explorer-reveal-"));
  deferCleanup(t, () => rm(root, { recursive: true, force: true }));
  const connection = new Connection("0.0.0", () => {}, () => {});
  deferCleanup(t, () => connection.dispose());
  for (const type of ["configuration", "extension", "processing", "report"]) {
    const fixture = await createTreeProject(join(root, type), type);
    if (type === "configuration" || type === "extension") await addCommonModules(fixture);
    await connection.connect({ executable, path: fixture.root, name: "test", locale: "ru-RU" });
    assert.equal(connection.state.kind, "ready");
    const tree = new MetadataTree(connection, connection.state.session, () => {}, () => {});
    let requests = 0;
    const request = connection.request.bind(connection);
    connection.request = (...args) => { requests++; return request(...args); };
    const module = await revealFile(tree, fixture.module);
    assert.equal(requests, 1, "cold reverse navigation is one backend request");
    connection.request = request;
    assert.equal(module.node.id.kind, "module");
    assert.equal(module.node.id.role, "object");
    const descriptor = await revealFile(tree, fixture.descriptor);
    assert.equal(descriptor.node.id.kind, "object");
    const progress = await tree.request(tree.projects[0], "metadata/index", { action: "status" });
    assert.equal(progress.progress.state, "not_started");
    assert.equal(await revealFile(tree, join(fixture.root, "eska.toml")), undefined);
    assert.equal(await revealFile(tree, join(fixture.source, "Catalogs", "Товары", "Ext", "Unknown.bsl")), undefined);
    if (type === "configuration" || type === "extension") {
      const sibling = [...tree.projects[0].nodes.values()].find(entry => entry.node.label.text === "Покупатели");
      assert.equal(sibling, undefined, "unrelated siblings are not transferred or retained");
    }
    tree.dispose();
  }
});
