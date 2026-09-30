import type * as vscode from "vscode";
import { message } from "./messages.js";
import { isRecord } from "./protocol.js";
import type { EditingField, PropertyChange, ValueType } from "./property-editing.js";

type Language = "ru-RU" | "en-US";
type Selection = { change: Extract<PropertyChange, { kind: "value" }>; title: string };

/** One composite value is saved only after its type and payload have both been selected. */
export async function pickPropertyValue(window: Pick<typeof vscode.window, "showQuickPick" | "showInputBox">,
  field: EditingField, language: Language,
  draft: PropertyChange | undefined,
  choices: (type: ValueType) => Promise<Record<string, unknown>>): Promise<Selection | undefined> {
  const options: { label: string; type: ValueType | undefined }[] = [
    { label: message(language, "propertyUnset"), type: undefined },
    ...(field.schema.types ?? []).map(type => ({ label: type.caption[language], type })),
  ];
  const selected = await window.showQuickPick(options, { title: message(language, "propertyChooseValue") });
  if (!selected) return undefined;
  const type = selected.type;
  if (!type) return { change: { kind: "value", key: null, value: "" }, title: selected.label };
  let value: string | undefined, title: string | undefined;
  const current = draft?.kind === "value" ? draft : { key: field.schema.key, value: field.value };
  const initial = JSON.stringify(current.key) === JSON.stringify(type.key) ? current.value : "";
  if (type.constraints.kind === "reference" || type.constraints.kind === "boolean") {
    const result = type.constraints.kind === "reference" ? await choices(type) : { choices: type.options };
    const options = (Array.isArray(result.choices) ? result.choices : []).filter(isRecord)
      .filter(option => typeof option.value === "string" && isRecord(option.caption))
      .map(option => ({ label: String((option.caption as Record<string, unknown>)[language] ?? option.value), value: option.value as string }));
    const picked = await window.showQuickPick(options, { title: selected.label });
    value = picked?.value; title = picked?.label;
  } else {
    const date = type.constraints.kind === "date";
    value = await window.showInputBox({ title: selected.label, value: date ? dateInput(initial, type, language) : initial,
      ...(date ? { prompt: message(language, type.constraints.fractions === "Date" ? "propertyDateOnlyFormat"
        : type.constraints.fractions === "Time" ? "propertyTimeFormat" : "propertyDateFormat") } : {}),
    });
    if (date && value !== undefined) value = dateValue(value, type, language);
  }
  if (value === undefined) return undefined;
  return { change: { kind: "value", key: type.key, value }, title: title ?? `${selected.label} · ${value || message(language, "propertyEmptyString")}` };
}

/** Show calendar values without a timezone conversion or an implementation-specific XML separator. */
function dateInput(value: string, type: ValueType, language: Language): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}:\d{2}:\d{2})$/.exec(value);
  if (!match) return value;
  const date = language === "ru-RU" ? `${match[3]}.${match[2]}.${match[1]}` : `${match[1]}-${match[2]}-${match[3]}`;
  const time = match[4] ?? "";
  return type.constraints.fractions === "Time" ? time : type.constraints.fractions === "Date" ? date : `${date} ${time}`;
}

/** Convert only an unambiguous display form; the backend still validates the calendar and qualifiers. */
function dateValue(value: string, type: ValueType, language: Language): string {
  if (type.constraints.fractions === "Time" && /^\d{2}:\d{2}(?::\d{2})?$/.test(value)) {
    return `0001-01-01T${value.length === 5 ? `${value}:00` : value}`;
  }
  const pattern = language === "ru-RU" ? /^(\d{2})\.(\d{2})\.(\d{4})(?: (\d{2}:\d{2}(?::\d{2})?))?$/
    : /^(\d{4})-(\d{2})-(\d{2})(?: (\d{2}:\d{2}(?::\d{2})?))?$/;
  const match = pattern.exec(value);
  if (!match) return value;
  const date = language === "ru-RU" ? `${match[3]}-${match[2]}-${match[1]}` : `${match[1]}-${match[2]}-${match[3]}`;
  const time = match[4] ?? "00:00:00";
  return `${date}T${time.length === 5 ? `${time}:00` : time}`;
}
