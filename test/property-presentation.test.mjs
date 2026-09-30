import { test } from "node:test";
import assert from "node:assert/strict";
import { propertyChoices, propertyFingerprint } from "../out/properties.js";
import { parsePresentation, referenceTargets } from "../out/property-presentation.js";
import { searchable } from "../resources/properties/model.mjs";
import { presentationView } from "../resources/properties/presentation.mjs";

const caption = { "ru-RU": "Организации", "en-US": "Companies" };
const reference = { kind: "reference", caption, category: { "ru-RU": "Справочник", "en-US": "Catalog" },
  status: "resolved", target: "catalog:Companies", metadataKind: "catalog" };
/** A namespace-aware original field remains available under semantic presentation. */
function field(presentation = reference) {
  return { key: { namespace: "http://v8.1c.ru/8.3/MDClasses", name: "Owner" }, qualifiers: [],
    value: { kind: "text", text: "Catalog.Companies" }, presentation, range: { start: 0, end: 50 } };
}

test("presentation preserves raw data, validates actionable references and falls back on future variants", () => {
  const [choice] = propertyChoices({ properties: [field()] }, "ru-RU");
  assert.equal(choice.value.text, "Catalog.Companies");
  assert.deepEqual(choice.presentation, reference);
  assert.deepEqual([...referenceTargets([choice])], [reference.target]);
  for (const invalid of [
    { ...reference, target: undefined }, { ...reference, status: "missing" },
    { ...reference, metadataKind: undefined }, { ...reference, caption: { "ru-RU": "name" } },
    { kind: "types", items: [] }, { kind: "empty", caption: null },
  ]) assert.throws(() => parsePresentation(invalid), { code: "protocolInvalid" });
  assert.equal(parsePresentation({ kind: "future", detail: "keep raw" }), undefined);
  assert.equal(parsePresentation(undefined), undefined);
});

test("search covers readable and technical values while source fingerprint ignores derived captions", () => {
  const value = field();
  assert.match(searchable(value, "ru-RU"), /организации/);
  assert.match(searchable(value, "ru-RU"), /catalog.companies/);
  assert.match(searchable(value, "en-US"), /companies/);
  const renamed = field({ ...reference, caption: { "ru-RU": "Новый синоним", "en-US": "New synonym" } });
  assert.equal(propertyFingerprint(value), propertyFingerprint(renamed));
  renamed.value.text = "Catalog.Other";
  assert.notEqual(propertyFingerprint(value), propertyFingerprint(renamed));
});

/** A small DOM records content and actions without executing workspace strings as markup. */
function documentFixture() {
  return { createElement(tag) { return { tag, children: [], listeners: {},
    append(...children) { this.children.push(...children); }, setAttribute() {},
    addEventListener(name, callback) { this.listeners[name] = callback; } }; } };
}
/** Traverse the rendered semantic rows independently of styling. */
function descendants(node) { return [node, ...node.children.flatMap(descendants)]; }

test("semantic rows expose keyboard buttons only for resolved targets and keep missing status visible", () => {
  const opened = [];
  const view = { kind: "types", items: [reference, { caption, detail: caption },
    { ...reference, status: "missing", target: undefined, caption: { "ru-RU": "<img onerror=evil>", "en-US": "Missing" } }] };
  const root = presentationView(documentFixture(), view, "ru-RU", { referenceMissing: "Объект не найден" }, {}, target => opened.push(target));
  const nodes = descendants(root);
  const buttons = nodes.filter(node => node.tag === "button");
  assert.equal(buttons.length, 1);
  buttons[0].listeners.click();
  assert.deepEqual(opened, [reference.target]);
  assert.ok(nodes.some(node => node.textContent === "Объект не найден"));
  assert.ok(nodes.some(node => node.textContent === "<img onerror=evil>"));
  assert.ok(nodes.every(node => node.innerHTML === undefined));
});
