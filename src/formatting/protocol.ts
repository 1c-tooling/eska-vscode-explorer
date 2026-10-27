import { createHash } from "node:crypto";
import { ExplorerError, isRecord } from "../protocol.js";
import { isByteRange, isSnapshot, unsigned, type ByteRange } from "../query/protocol.js";
import { withQueryText, type QueryTextInput } from "../query/text-transfer.js";

export type FormatMethod = "format/document" | "format/query" | "format/bufferBegin" | "format/bufferAppend" | "format/bufferClose";
export interface FormatLimits { maxTextBytes: number; maxInlineBytes: number }
export interface FormatEndpoint {
  readonly limits: FormatLimits;
  request(method: FormatMethod, params: Record<string, unknown>, signal?: AbortSignal): Promise<unknown>;
}
export interface NativeFormatEdit { start: number; end: number; text: string }

/** Formatting is an independent, explicitly negotiated plan-only component contract. */
export function formatCapabilities(hello: unknown): FormatLimits | undefined {
  if (!isRecord(hello) || !isRecord(hello.capabilities) || hello.capabilities.formatting === undefined) return undefined;
  const value = hello.capabilities.formatting;
  if (!isRecord(hello.apiVersion) || hello.apiVersion.major !== 1 || !unsigned(hello.apiVersion.minor) || hello.apiVersion.minor < 33
    || !isRecord(value) || value.schemaVersion !== 1 || value.component !== "eska-fmt" || value.protocolVersion !== 1
    || value.planOnly !== true || value.writesOwner !== false || value.document !== true || value.range !== true || value.queryDraft !== true
    || value.formatOnSave !== "opt_in" || !Array.isArray(value.languages) || !value.languages.includes("bsl") || !value.languages.includes("sdbl")
    || !unsigned(value.maxTextBytes) || value.maxTextBytes === 0 || !unsigned(value.maxInlineBytes) || value.maxInlineBytes === 0) invalid();
  return { maxTextBytes: Math.min(value.maxTextBytes, 4_194_304), maxInlineBytes: Math.min(value.maxInlineBytes, 131_072) };
}

/** Reuse the existing bounded UTF-8 transfer; allocation replies precede cancellation and cleanup. */
export function withFormatText<T>(endpoint: FormatEndpoint, text: string, use: (input: QueryTextInput) => Promise<T>, signal?: AbortSignal): Promise<T> {
  return withQueryText(text, { maxSnapshotBytes: endpoint.limits.maxTextBytes, maxInlineBytes: endpoint.limits.maxInlineBytes },
    (method, params) => endpoint.request(method.replace("query/", "format/") as FormatMethod, params),
    async bufferId => { await endpoint.request("format/bufferClose", { bufferId }); }, use, signal);
}

/** Validate the exact snapshot before converting UTF-8 byte boundaries into native UTF-16 offsets. */
export function formatEdits(value: unknown, text: string, version: number): NativeFormatEdit[] {
  const bytes = Buffer.from(text, "utf8");
  if (bytes.toString("utf8") !== text || !isRecord(value) || value.schemaVersion !== 1 || value.version !== String(version)
    || !isRecord(value.plan) || value.plan.schema_version !== 1 || !isSnapshot(value.plan.source_sha256)
    || value.plan.source_sha256 !== createHash("sha256").update(bytes).digest("hex")
    || !isByteRange(value.plan.formatted_range, bytes.length) || !Array.isArray(value.plan.edits) || value.plan.edits.length > 1024) invalid();
  const edits: { range: ByteRange; text: string }[] = [];
  const boundaries = new Set<number>();
  let previous: ByteRange | undefined, outputBytes = bytes.length;
  for (const raw of value.plan.edits) {
    if (!isRecord(raw) || !isByteRange(raw.range, bytes.length) || typeof raw.text !== "string"
      || Buffer.from(raw.text, "utf8").toString("utf8") !== raw.text
      || raw.range.start < value.plan.formatted_range.start || raw.range.end > value.plan.formatted_range.end
      || previous && (previous.end > raw.range.start || previous.start === raw.range.start)) invalid();
    outputBytes += Buffer.byteLength(raw.text) - (raw.range.end - raw.range.start);
    if (outputBytes > 16_777_216) invalid();
    for (const offset of [raw.range.start, raw.range.end]) boundaries.add(offset);
    edits.push({ range: raw.range, text: raw.text }); previous = raw.range;
  }
  for (const offset of [value.plan.formatted_range.start, value.plan.formatted_range.end, ...boundaries]) {
    if (offset < bytes.length && (bytes[offset]! & 0xc0) === 0x80) invalid();
  }
  const native = new Map<number, number>();
  let byte = 0, offset = 0;
  // One pass bounds conversion cost even if a component returns many edits in a large Unicode buffer.
  for (const point of text) {
    if (boundaries.has(byte)) native.set(byte, offset);
    const code = point.codePointAt(0)!;
    byte += code <= 0x7f ? 1 : code <= 0x7ff ? 2 : code <= 0xffff ? 3 : 4;
    offset += point.length;
  }
  if (boundaries.has(byte)) native.set(byte, offset);
  return edits.map(edit => ({ start: native.get(edit.range.start)!, end: native.get(edit.range.end)!, text: edit.text }));
}

/** Protocol errors never permit a partially converted editor edit. */
function invalid(): never { throw new ExplorerError("protocolInvalid"); }
