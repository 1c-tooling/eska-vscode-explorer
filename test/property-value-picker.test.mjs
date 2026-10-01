import { test } from "node:test";
import assert from "node:assert/strict";
import { pickPropertyValue } from "../out/property-value-picker.js";

/** Select a supplied schema type; real writes remain outside the native dialog helper. */
function field(kind, fractions) {
  return { value: "2024-02-29T12:34:56", schema: { key: { namespace: "xs", name: kind }, types: [{
    key: { namespace: "xs", name: kind }, caption: { "ru-RU": kind, "en-US": kind }, constraints: { kind, fractions },
  }] } };
}

test("native value picker distinguishes cancellation, undefined and an empty string", async () => {
  const choices = async () => { throw new Error("primitive never enumerates references"); };
  assert.equal(await pickPropertyValue({ showQuickPick: async () => undefined }, field("string"), "ru-RU", undefined, choices), undefined);
  const unset = await pickPropertyValue({ showQuickPick: async options => options[0] }, field("string"), "ru-RU", undefined, choices);
  assert.deepEqual(unset.change, { kind: "value", key: null, value: "" });
  const window = { showQuickPick: async options => options.at(-1), showInputBox: async () => "" };
  const empty = await pickPropertyValue(window, field("string"), "ru-RU", undefined, choices);
  assert.equal(empty.change.value, ""); assert.notEqual(empty.change.key, null);
  window.showInputBox = async () => undefined;
  assert.equal(await pickPropertyValue(window, field("string"), "ru-RU", undefined, choices), undefined);
});

test("calendar display and entry never use timezone conversion", async () => {
  for (const [locale, fractions, input, expected] of [
    ["ru-RU", "DateTime", "01.10.2026 12:00", "2026-10-01T12:00:00"],
    ["ru-RU", "Date", "29.02.2024", "2024-02-29T00:00:00"],
    ["en-US", "Date", "2024-02-29", "2024-02-29T00:00:00"],
    ["ru-RU", "Time", "23:45", "0001-01-01T23:45:00"],
  ]) {
    let display;
    const window = { showQuickPick: async options => options.at(-1), showInputBox: async options => { display = options.value; return input; } };
    const result = await pickPropertyValue(window, field("date", fractions), locale, undefined, async () => ({}));
    assert.equal(result.change.value, expected);
    assert.ok(!display.includes("T"));
  }
});

test("choice parameters load project reference types lazily and retain primitive choices", async () => {
  const current = field("string");
  current.schema.domain = "choiceParameter";
  const key = { namespace: "http://v8.1c.ru/8.1/data/enterprise/current-config", name: "EnumRef.Status" };
  const caption = { "ru-RU": "Перечисление: Статус", "en-US": "Enum: Status" };
  let typesRequested = 0, valuesRequested = 0, stage = 0;
  const window = { showQuickPick: async options => { stage++; return options.at(-1); } };
  const result = await pickPropertyValue(window, current, "ru-RU", undefined, async type => {
    valuesRequested++; assert.deepEqual(type.key, key);
    return { choices: [{ value: "Enum.Status.EnumValue.Ready", caption: { "ru-RU": "Готов", "en-US": "Ready" } }] };
  }, async () => { typesRequested++; return { choices: [current.schema.types[0], { key, caption, metadataKind: "enum" }] }; });
  assert.equal(stage, 2); assert.equal(typesRequested, 1); assert.equal(valuesRequested, 1);
  assert.deepEqual(result, { change: { kind: "value", key, value: "Enum.Status.EnumValue.Ready" }, title: "Готов" });
  let initial;
  await pickPropertyValue({ showQuickPick: async options => options[1], showInputBox: async options => { initial = options.value; return undefined; } },
    current, "ru-RU", { kind: "value", key: current.schema.key, value: "draft" }, async () => ({}), async () => ({ choices: [current.schema.types[0]] }));
  assert.equal(initial, "draft");
  await assert.rejects(pickPropertyValue(window, current, "ru-RU", undefined, async () => ({}),
    async () => ({ choices: [{ key: { namespace: "foreign", name: "value" }, caption }] })), /Unsupported value type/);
});
