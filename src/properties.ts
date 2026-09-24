import { createHash } from "node:crypto";
import { message } from "./messages.js";
import { ExplorerError, isRecord } from "./protocol.js";

export interface PropertyChoice {
  label: string;
  description: string;
  index: number;
  fingerprint: string;
  range: { start: number; end: number };
}

/** A small digest detects edits while the picker is open without retaining large values twice. */
export function propertyFingerprint(property: unknown): string {
  return createHash("sha256").update(JSON.stringify(property)).digest("hex");
}

/** Show a bounded value preview without interpreting Designer XML in the extension. */
function preview(value: unknown, language: string): string {
  if (!isRecord(value)) throw new ExplorerError("protocolInvalid");
  let text: string;
  switch (value.kind) {
    case "text":
      if (typeof value.text !== "string") throw new ExplorerError("protocolInvalid");
      text = value.text;
      break;
    case "localized":
      if (!Array.isArray(value.items) || !value.items.every(item => isRecord(item)
        && typeof item.language === "string" && typeof item.content === "string")) throw new ExplorerError("protocolInvalid");
      text = value.items.map(item => `${item.language}: ${item.content}`).join(" · ");
      break;
    case "record":
      if (!Array.isArray(value.fields)) throw new ExplorerError("protocolInvalid");
      text = message(language, "propertyFields", String(value.fields.length));
      break;
    case "unsupported":
      if (typeof value.issue !== "string") throw new ExplorerError("protocolInvalid");
      text = message(language, "propertyXmlOnly");
      break;
    default: throw new ExplorerError("protocolInvalid");
  }
  const oneLine = text.replace(/\s+/gu, " ").trim();
  return oneLine.length > 100 ? `${oneLine.slice(0, 99)}…` : oneLine || "—";
}

/** Keep backend property order and byte ranges; the Quick Pick filters names and previews. */
export function propertyChoices(response: unknown, language: string): PropertyChoice[] {
  if (!isRecord(response) || !Array.isArray(response.properties)) throw new ExplorerError("protocolInvalid");
  return response.properties.map((property: unknown, index: number) => {
    if (!isRecord(property) || !isRecord(property.key) || typeof property.key.name !== "string"
      || !property.key.name || !(property.key.namespace === null || typeof property.key.namespace === "string")
      || !isRecord(property.range) || !Number.isSafeInteger(property.range.start)
      || !Number.isSafeInteger(property.range.end) || (property.range.start as number) < 0
      || (property.range.end as number) < (property.range.start as number)) throw new ExplorerError("protocolInvalid");
    return {
      label: property.key.name,
      description: preview(property.value, language),
      index,
      fingerprint: propertyFingerprint(property),
      range: { start: property.range.start as number, end: property.range.end as number },
    };
  });
}
