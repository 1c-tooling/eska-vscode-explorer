import { createHash } from "node:crypto";
import { message } from "./messages.js";
import { ExplorerError, isRecord } from "./protocol.js";

export interface PropertyKey { namespace: string | null; name: string }
export interface PropertyQualifier { key: PropertyKey; value: string; caption?: PropertyCaption }
export interface PropertyCaption { "ru-RU": string; "en-US": string }
export interface PropertyField { key: PropertyKey; caption?: PropertyCaption; qualifiers: PropertyQualifier[]; value: PropertyValue }
export type PropertyValue = { kind: "text"; text: string; caption?: PropertyCaption; scalarType?: "boolean" }
  | { kind: "localized"; items: { language: string; content: string }[] }
  | { kind: "record"; fields: PropertyField[] }
  | { kind: "unsupported"; issue: string };

const METADATA_NAMESPACE = "http://v8.1c.ru/8.3/MDClasses";

export interface PropertyChoice {
  label: string;
  description: string;
  index: number;
  fingerprint: string;
  range: { start: number; end: number };
  key: PropertyKey;
  caption?: PropertyCaption;
  qualifiers: PropertyQualifier[];
  value: PropertyValue;
}

/** Prefer the tree language, then any nonempty synonym defined for the object. */
export function objectSynonym(properties: readonly PropertyChoice[], language: string): string | undefined {
  const synonym = properties.find(property => property.key.namespace === METADATA_NAMESPACE
    && property.key.name === "Synonym" && property.value.kind === "localized");
  if (!synonym || synonym.value.kind !== "localized") return undefined;
  const items = synonym.value.items.filter(item => item.content.trim());
  const preferred = language.toLowerCase();
  const base = preferred.split("-")[0];
  return (items.find(item => item.language.toLowerCase() === preferred)
    ?? items.find(item => item.language.toLowerCase() === base)
    ?? items[0])?.content.trim();
}

/** A small digest detects edits while the tab is open without retaining large values twice. */
export function propertyFingerprint(property: unknown): string {
  return createHash("sha256").update(JSON.stringify(property)).digest("hex");
}

/** Namespace-aware keys stay distinct even when Designer uses different XML prefixes. */
function parseKey(value: unknown): PropertyKey {
  if (!isRecord(value) || typeof value.name !== "string" || !value.name
    || !(value.namespace === null || typeof value.namespace === "string")) throw new ExplorerError("protocolInvalid");
  return { namespace: value.namespace, name: value.name };
}

/** Preserve ordered nested fields and annotations for the property tab. */
function parseField(value: unknown, depth: number): PropertyField {
  if (!isRecord(value) || depth > 32) throw new ExplorerError("protocolInvalid");
  const annotations = value.qualifiers ?? [];
  if (!Array.isArray(annotations)) throw new ExplorerError("protocolInvalid");
  const qualifiers = annotations.map((qualifier: unknown) => {
    if (!isRecord(qualifier) || typeof qualifier.value !== "string") throw new ExplorerError("protocolInvalid");
    return { key: parseKey(qualifier.key), value: qualifier.value, ...parseCaption(qualifier.caption) };
  });
  return { key: parseKey(value.key), qualifiers, value: parseValue(value.value, depth), ...parseCaption(value.caption) };
}

/** Validate optional presentation metadata without modifying the original scalar value. */
function parseCaption(value: unknown): { caption?: PropertyCaption } {
  if (value === undefined) return {};
  if (!isRecord(value) || typeof value["ru-RU"] !== "string" || typeof value["en-US"] !== "string"
    || !value["ru-RU"].trim() || !value["en-US"].trim()) throw new ExplorerError("protocolInvalid");
  return { caption: { "ru-RU": value["ru-RU"], "en-US": value["en-US"] } };
}

/** Validate the backend's four value shapes before sending them to the webview. */
function parseValue(value: unknown, depth: number): PropertyValue {
  if (!isRecord(value)) throw new ExplorerError("protocolInvalid");
  if (value.kind === "text" && typeof value.text === "string") {
    if (value.scalarType === "boolean" && !["true", "false", "1", "0"].includes(value.text.trim())) {
      throw new ExplorerError("protocolInvalid");
    }
    return { kind: "text", text: value.text, ...parseCaption(value.caption),
      ...(value.scalarType === "boolean" ? { scalarType: "boolean" } : {}) };
  }
  if (value.kind === "localized" && Array.isArray(value.items) && value.items.every(item => isRecord(item)
    && typeof item.language === "string" && typeof item.content === "string")) {
    return { kind: "localized", items: value.items.map(item => ({ language: item.language, content: item.content })) };
  }
  if (value.kind === "record" && Array.isArray(value.fields)) {
    return { kind: "record", fields: value.fields.map(field => parseField(field, depth + 1)) };
  }
  if (value.kind === "unsupported" && typeof value.issue === "string") return { kind: "unsupported", issue: value.issue };
  throw new ExplorerError("protocolInvalid");
}

/** Show a bounded value preview without interpreting Designer XML in the extension. */
function preview(value: PropertyValue, language: string): string {
  let text: string;
  switch (value.kind) {
    case "text":
      text = value.caption?.[language.toLowerCase().startsWith("ru") ? "ru-RU" : "en-US"] ?? value.text;
      break;
    case "localized":
      text = value.items.map(item => `${item.language}: ${item.content}`).join(" · ");
      break;
    case "record":
      text = message(language, "propertyFields", String(value.fields.length));
      break;
    case "unsupported":
      text = message(language, "propertyXmlOnly");
      break;
    default: throw new ExplorerError("protocolInvalid");
  }
  const oneLine = text.replace(/\s+/gu, " ").trim();
  return oneLine.length > 100 ? `${oneLine.slice(0, 99)}…` : oneLine || "—";
}

/** Keep backend property order and byte ranges for the property tab and XML action. */
export function propertyChoices(response: unknown, language: string): PropertyChoice[] {
  if (!isRecord(response) || !Array.isArray(response.properties)) throw new ExplorerError("protocolInvalid");
  return response.properties.map((property: unknown, index: number) => {
    if (!isRecord(property) || !isRecord(property.range) || !Number.isSafeInteger(property.range.start)
      || !Number.isSafeInteger(property.range.end) || (property.range.start as number) < 0
      || (property.range.end as number) < (property.range.start as number)) throw new ExplorerError("protocolInvalid");
    const field = parseField(property, 0);
    return {
      label: field.key.name,
      description: preview(field.value, language),
      index,
      fingerprint: propertyFingerprint(property),
      range: { start: property.range.start as number, end: property.range.end as number },
      ...field,
    };
  });
}
