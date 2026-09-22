import { test } from "node:test";
import assert from "node:assert/strict";
import { ProjectSorting } from "../out/sorting.js";

/** An in-memory workspace store preserves the same asynchronous contract as VS Code. */
function storage() {
  const values = new Map();
  return { get: key => values.get(key), async update(key, value) { values.set(key, value); } };
}

/** Object IDs and labels deliberately differ to catch accidental identity-based sorting. */
function entry(label, kind = "object") {
  return { node: { id: { kind, objectId: `opaque-${label}` }, label: { kind: "name", text: label } } };
}

const first = { key: 'project-a' }, second = { key: 'project-b' };

test("sorting defaults to original, persists per project and restores the exact backend order", async () => {
  const state = storage();
  let sorting = new ProjectSorting(state);
  const original = Object.freeze([entry("Яблоко"), entry("Арбуз"), entry("Банан")]);
  assert.equal(sorting.order(first), "original");
  assert.equal(sorting.children(first, original, "ru-RU"), original);
  await sorting.set(first, "alphabetical");
  sorting = new ProjectSorting(state);
  assert.equal(sorting.order({ ...first }), "alphabetical");
  assert.equal(sorting.order(second), "original");
  assert.deepEqual(sorting.children(first, original, "ru-RU"), [original[1], original[2], original[0]]);
  assert.equal(sorting.children(second, original, "ru-RU"), original);
  await sorting.set(first, "original");
  assert.equal(sorting.children(first, original, "ru-RU"), original);
});

test("alphabetical sorting includes groups, modules and direct subordinate objects", async () => {
  const sorting = new ProjectSorting(storage());
  await sorting.set(first, "alphabetical");
  const modules = entry("Модули", "collection"), attributes = entry("Реквизиты", "collection"), module = entry("Объект", "module");
  const z = entry("Я"), a = entry("А");
  const original = Object.freeze([modules, z, attributes, a, module]);
  assert.deepEqual(sorting.children(first, original, "ru-RU"), [a, modules, module, attributes, z]);
  assert.deepEqual(sorting.children(first, [z, a], "ru-RU"), [a, z]);
  assert.deepEqual(original, [modules, z, attributes, a, module]);
});

test("alphabetical comparison handles Russian, English, numbers and stable equal labels", async () => {
  const sorting = new ProjectSorting(storage());
  await sorting.set(first, "alphabetical");
  for (const [locale, labels, expected] of [
    ["ru-RU", ["Поле10", "Я", "поле2", "А"], ["А", "поле2", "Поле10", "Я"]],
    ["en-US", ["Zebra", "field10", "Apple", "Field2"], ["Apple", "Field2", "field10", "Zebra"]],
  ]) {
    assert.deepEqual(sorting.children(first, labels.map(name => entry(name)), locale).map(value => value.node.label.text), expected);
  }
  const equal = [entry("alpha"), entry("ALPHA"), entry("Alpha")];
  assert.deepEqual(sorting.children(first, equal, "en-US"), equal);
});

test("invalid stored preferences and failed saves preserve the original order", async () => {
  const sorting = new ProjectSorting({ get: () => "unsupported", async update() { throw new Error("write failed"); } });
  assert.equal(sorting.order(first), "original");
  await assert.rejects(sorting.set(first, "alphabetical"), /write failed/);
  assert.equal(sorting.order(first), "original");
});


test("structural groups follow displayed translations in the selected tree language", async () => {
  const sorting = new ProjectSorting(storage());
  await sorting.set(first, "alphabetical");
  const common = entry("unused", "collection"), documents = entry("unused2", "collection");
  common.node.label = { kind: "key", translations: { "ru-RU": "Общие", "en-US": "Common" } };
  documents.node.label = { kind: "key", translations: { "ru-RU": "Документы", "en-US": "Documents" } };
  const original = Object.freeze([common, documents]);
  assert.deepEqual(sorting.children(first, original, "ru-RU"), [documents, common]);
  assert.deepEqual(sorting.children(first, original, "en-US"), [common, documents]);
});
