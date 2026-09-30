import { ExplorerError, isRecord, isWirePath, type WirePath } from "./protocol.js";
import type { PropertyKey, PropertyCaption } from "./properties.js";

export interface FieldStep { key: PropertyKey; occurrence: number }
export type PropertyChange = { kind: "text"; value: string } | { kind: "dataType"; key: PropertyKey }
  | { kind: "value"; key: PropertyKey | null; value: string };
export interface ValueType {
  key: PropertyKey;
  caption: PropertyCaption;
  constraints: { kind: "string" | "number" | "boolean" | "date" | "reference"; fractions?: string };
  options?: { value: string; caption: PropertyCaption }[];
}
export interface EditingField {
  path: FieldStep[];
  value: string;
  language: string | null;
  captions: PropertyCaption[];
  caption?: PropertyCaption;
  options?: { value: string; caption: PropertyCaption }[];
  schema: { kind: "text" | "boolean" | "integer" | "decimal" | "enum" | "dataType" | "reference" | "value"; min?: number; max?: number; key?: PropertyKey | null; nullable?: boolean; types?: ValueType[] };
}
export interface EditingSchema {
  snapshot: string;
  source: WirePath;
  writable: boolean;
  undo: boolean;
  redo: boolean;
  fields: EditingField[];
}
export interface EditingView {
  unlocked: boolean;
  busy: boolean;
  blocked: boolean;
  schema: EditingSchema | undefined;
  drafts: Record<string, PropertyChange>;
  draftTitles: Record<string, string>;
}

/** Logical paths remain stable when a preceding property's presentation changes. */
export function fieldId(path: FieldStep[]): string { return JSON.stringify(path); }

/** Only expanded XML identities are accepted; prefixes and source offsets never address writes. */
function isKey(value: unknown): value is PropertyKey {
  return isRecord(value) && typeof value.name === "string" && value.name.length > 0
    && (value.namespace === null || typeof value.namespace === "string");
}

/** Value dialogs require typed choices with both captions; malformed responses never expose controls. */
function isValueSchema(value: Record<string, unknown>): boolean {
  if (value.key !== null && !isKey(value.key)) return false;
  return Array.isArray(value.types) && value.types.length > 0 && value.types.every(type => isRecord(type)
    && isKey(type.key) && isRecord(type.caption) && typeof type.caption["ru-RU"] === "string"
    && typeof type.caption["en-US"] === "string" && isRecord(type.constraints)
    && ["string", "number", "boolean", "date", "reference"].includes(String(type.constraints.kind))
    && (type.constraints.kind !== "date" || ["DateTime", "Date", "Time"].includes(String(type.constraints.fractions))));
}

/** Validate the backend schema before exposing a write control or storing its file location. */
export function editingSchema(value: unknown): EditingSchema {
  if (!isRecord(value) || typeof value.snapshot !== "string" || !/^[a-f0-9]{64}$/.test(value.snapshot)
    || !isWirePath(value.source) || typeof value.writable !== "boolean" || typeof value.undo !== "boolean"
    || typeof value.redo !== "boolean" || !Array.isArray(value.fields) || value.fields.some(field => !isRecord(field)
      || !Array.isArray(field.path) || !field.path.length || field.path.length > 64
      || field.path.some(step => !isRecord(step) || !isKey(step.key) || !Number.isSafeInteger(step.occurrence) || (step.occurrence as number) < 0)
      || typeof field.value !== "string" || !Array.isArray(field.captions)
      || !isRecord(field.schema) || !["text", "boolean", "integer", "decimal", "enum", "dataType", "reference", "value"].includes(String(field.schema.kind))
      || (field.schema.kind === "value" && !isValueSchema(field.schema)))) {
    throw new ExplorerError("protocolInvalid");
  }
  return value as unknown as EditingSchema;
}

/** UI messages can propose only the operation advertised for the selected field. */
export function propertyChange(value: unknown, field: EditingField): PropertyChange | undefined {
  if (!isRecord(value)) return undefined;
  if (value.kind === "text" && !["dataType", "reference", "value"].includes(field.schema.kind) && typeof value.value === "string" && value.value.length <= 1_048_576) {
    return { kind: "text", value: value.value };
  }
  return undefined; // Data type changes originate exclusively from the host's checked picker.
}
