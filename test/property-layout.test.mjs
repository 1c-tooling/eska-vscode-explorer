import { test } from "node:test";
import assert from "node:assert/strict";
import { APP, MD, booleanValue, checklistEntry, childrenWithPaths, identity, isCollection, localizedEntries, searchable, summary } from "../resources/properties/model.mjs";

/** Construct schema-shaped data without coupling tests to DOM implementation. */
function field(namespace, name, value, caption) {
  return { key: { namespace, name }, qualifiers: [], value, ...(caption ? { caption } : {}) };
}
/** A mobile item preserves both raw identity and localized value. */
function mobile(token, checked) {
  return field(APP, "functionality", { kind: "record", fields: [
    field(APP, "functionality", { kind: "text", text: token, caption: { "ru-RU": "Биометрия", "en-US": "Biometrics" } }),
    field(APP, "use", { kind: "text", text: String(checked) }),
  ] });
}

test("mobile flags become a checklist only when every field can be represented", () => {
  const entry = mobile("Biometrics", true);
  const root = field(MD, "UsedMobileApplicationFunctionalities", { kind: "record", fields: [entry] });
  assert.ok(isCollection(root));
  assert.equal(checklistEntry(root, entry).checked, true);
  assert.equal(checklistEntry(root, entry).name.caption["ru-RU"], "Биометрия");
  assert.equal(checklistEntry(root, mobile("Location", false)).checked, false);
  assert.equal(checklistEntry(field("urn:foreign", root.key.name, root.value), entry), undefined);
  const extended = structuredClone(entry);
  extended.value.fields.push(field(APP, "description", { kind: "text", text: "Do not lose me" }));
  assert.equal(checklistEntry(root, extended), undefined);
  extended.value.fields.pop();
  extended.qualifiers.push({ key: { namespace: null, name: "extra" }, value: "keep" });
  assert.equal(checklistEntry(root, extended), undefined);
});

test("records stay full structures and collection identities come from names", () => {
  const value = field(MD, "Type", { kind: "record", fields: [
    field("core", "Type", { kind: "text", text: "xs:string", caption: { "ru-RU": "Строка", "en-US": "String" } }),
    field("core", "Length", { kind: "text", text: "100" }, { "ru-RU": "Длина", "en-US": "Length" }),
  ] });
  assert.equal(isCollection(value), false);
  assert.match(summary(value, "ru-RU"), /Строка/);
  assert.match(summary(value, "ru-RU"), /Длина: 100/);
  value.qualifiers.push({ key: { namespace: null, name: "name" }, value: "Code", caption: { "ru-RU": "Код", "en-US": "Code" } });
  assert.deepEqual(identity(value, "ru-RU"), { title: "Код", raw: "Code" });
  assert.equal(booleanValue({ kind: "text", text: "TRUE" }), undefined);
});

test("search retains raw tokens, translated nested values and annotations", () => {
  const root = field(MD, "UsedMobileApplicationFunctionalities", { kind: "record", fields: [mobile("Biometrics", true)] });
  const text = searchable(root, "ru-RU");
  assert.ok(text.includes("биометрия"));
  assert.ok(text.includes("biometrics"));
  assert.ok(text.includes("true"));
});

test("expansion identities distinguish duplicate fields and survive unrelated insertions and relabeling", () => {
  const entry = mobile("Biometrics", true);
  const original = childrenWithPaths([entry, entry], "root");
  assert.notEqual(original[0].path, original[1].path);
  const updated = childrenWithPaths([field(MD, "NewField", { kind: "text", text: "value" }), { ...entry, caption: { "ru-RU": "Другая подпись", "en-US": "Other" } }], "root");
  assert.equal(original[0].path, updated[1].path);
});

test("localized wrappers become language rows only when every field is retained", () => {
  const core = "http://v8.1c.ru/8.1/data/core";
  const item = field(core, "item", { kind: "record", fields: [
    field(core, "lang", { kind: "text", text: "ru" }), field(core, "content", { kind: "text", text: "Товары" }),
  ] });
  const value = { kind: "record", fields: [item] };
  assert.deepEqual(localizedEntries(value), [{ language: "ru", content: "Товары" }]);
  item.value.fields[1].qualifiers.push({ key: { namespace: null, name: "format" }, value: "keep" });
  assert.equal(localizedEntries(value), undefined);
});
