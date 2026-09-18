import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { resolve, join } from "node:path";
import { Connection } from "../out/connection.js";
import { MetadataTree } from "../out/tree.js";
import { revealFile, relativeFile } from "../out/reveal.js";
import { createTreeProject, addCommonModules } from "./fixture.mjs";

const executable = process.env.ESKA_TEST_BINARY;

test("file containment rejects sibling-prefix folders", () => {
  const root = resolve("project");
  assert.equal(relativeFile(root, join(root, "src", "a.bsl")), join("src", "a.bsl"));
  assert.equal(relativeFile(root, `${root}-other/a.bsl`), undefined);
});

test("reverse navigation resolves cold branches without a full search index", { skip: !executable }, async t => {
  const root = await mkdtemp(join(process.env.ESKA_TEST_ROOT ?? resolve("../eska-playground"), "explorer-reveal-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const connection = new Connection("0.0.0", () => {}, () => {});
  t.after(() => connection.dispose());
  for (const type of ["configuration", "extension", "processing", "report"]) {
    const fixture = await createTreeProject(join(root, type), type);
    if (type === "configuration" || type === "extension") await addCommonModules(fixture);
    await connection.connect({ executable, path: fixture.root, name: "test", locale: "ru-RU" });
    assert.equal(connection.state.kind, "ready");
    const tree = new MetadataTree(connection, connection.state.session, () => {}, () => {});
    const module = await revealFile(tree, fixture.module);
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
      assert.equal(sibling.children, undefined, "unrelated object stays unexpanded");
    }
    tree.dispose();
  }
});
