import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { propertyChoices } from "../out/properties.js";
import { resolvePropertySource } from "../out/source.js";
import { Connection } from "../out/connection.js";
import { MetadataTree } from "../out/tree.js";
import { createTreeProject } from "./fixture.mjs";

/** Property previews stay concise while full values and ranges remain backend-owned. */
test("property tab data preserves order, repeated names and structured values", () => {
  const range = { start: 3, end: 12 };
  const key = { namespace: null, name: "Name" };
  const properties = [
    { key, range, value: { kind: "text", text: "😀\n длинное значение" } },
    { key, range, value: { kind: "localized", items: [{ language: "ru", content: "Товар" }, { language: "en", content: "Goods" }] } },
    { key: { ...key, name: "Type" }, range, value: { kind: "record", fields: [
      { key, qualifiers: [{ key: { namespace: "urn:test", name: "type" }, value: "String" }], value: { kind: "text", text: "String" } },
      { key, value: { kind: "text", text: "Number" } },
    ] } },
    { key: { ...key, name: "Other" }, range, value: { kind: "unsupported", issue: "mixed_content" } },
  ];
  const choices = propertyChoices({ properties }, "ru-RU");
  assert.deepEqual(choices.map(choice => choice.label), ["Name", "Name", "Type", "Other"]);
  assert.equal(choices[0].description, "😀 длинное значение");
  assert.equal(choices[1].description, "ru: Товар · en: Goods");
  assert.equal(choices[2].description, "Полей: 2");
  assert.deepEqual(choices[2].value.fields.map(field => field.key.name), ["Name", "Name"]);
  assert.equal(choices[2].value.fields[0].qualifiers[0].key.namespace, "urn:test");
  assert.equal(choices[3].description, "Смотрите в XML");
  assert.equal(choices[1].index, 1);
  assert.throws(() => propertyChoices({ properties: [{ ...properties[0], range: { start: 12, end: 3 } }] }, "en-US"),
    { code: "protocolInvalid" });
  assert.throws(() => propertyChoices({ properties: [{ ...properties[2], value: { kind: "record", fields: [{ key, value: null }] } }] }, "en-US"),
    { code: "protocolInvalid" });
});

/** Real Designer mappings select the intended property for root, object and inline child. */
test("property action opens exact XML and rejects a stale tab result", { skip: !process.env.ESKA_TEST_BINARY }, async t => {
  const directory = await mkdtemp(join(process.env.ESKA_TEST_ROOT ?? resolve("../eska-playground"), "explorer-properties-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const fixture = await createTreeProject(join(directory, "project"));
  const connection = new Connection("test", () => {}, () => {});
  t.after(() => connection.dispose());
  await connection.connect({ executable: process.env.ESKA_TEST_BINARY, path: fixture.root, name: "test", locale: "ru-RU" });
  const tree = new MetadataTree(connection, connection.state.session, () => {}, () => {});
  t.after(() => tree.dispose());
  const [root] = await tree.roots();
  const catalogs = (await tree.children(root)).find(entry => entry.node.id.collection?.metadataKind === "catalog");
  assert.ok(catalogs);
  const goods = (await tree.children(catalogs)).find(entry => entry.node.label.text === "Товары");
  assert.ok(goods);
  const attributes = (await tree.children(goods)).find(entry => entry.node.id.collection?.metadataKind === "attribute");
  assert.ok(attributes);
  const [attribute] = await tree.children(attributes);
  for (const [entry, name, snippet, path] of [
    [root, "Comment", "<Comment>😀 Кириллица</Comment>", join(fixture.source, "Configuration.xml")],
    [goods, "Comment", "<Comment>😀 Кириллица</Comment>", fixture.descriptor],
    [attribute, "Name", "<Name>Артикул</Name>", fixture.descriptor],
  ]) {
    const properties = await tree.request(entry.project, "metadata/properties", { objectId: entry.node.id.objectId });
    const choice = propertyChoices(properties, "ru-RU").find(value => value.label === name);
    assert.ok(choice);
    const source = await resolvePropertySource(tree, entry, choice);
    assert.equal(source.path, path);
    assert.equal(source.position.text.slice(source.position.start, source.position.end), snippet);
  }
  const properties = await tree.request(goods.project, "metadata/properties", { objectId: goods.node.id.objectId });
  const choice = propertyChoices(properties, "ru-RU").find(value => value.label === "Comment");
  assert.ok(choice);
  await writeFile(fixture.descriptor, (await readFile(fixture.descriptor, "utf8"))
    .replace("<Comment>😀 Кириллица</Comment>", "<Comment>Новое значение</Comment>"));
  await tree.refresh(goods.project, goods);
  await assert.rejects(resolvePropertySource(tree, goods, choice), { code: "sourceChanged" });
  assert.ok((await readFile(fixture.descriptor, "utf8")).includes("Новое значение"));
});
