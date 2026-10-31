import { createHash } from "node:crypto";
import { ExplorerError, isRecord } from "../protocol.js";
import { isByteRange, isSnapshot, unsigned } from "../query/protocol.js";
import { withQueryText, type QueryTextInput } from "../query/text-transfer.js";

export type StringMethod = "language/multilineStrings" | "language/bufferBegin" | "language/bufferAppend" | "language/bufferClose";
export interface StringLimits { maxTextBytes: number; maxInlineBytes: number; maxContinuations: number }
export interface StringEndpoint {
  readonly limits: StringLimits;
  request(method: StringMethod, params: Record<string, unknown>, signal?: AbortSignal): Promise<unknown>;
}
export interface MultilineString { start: number; end: number; continuations: readonly number[] }

/** Syntax belongs to ESKA; this capability transports exact positions, independent of an analyzer. */
export function stringCapabilities(hello: unknown): StringLimits | undefined {
  if (!isRecord(hello) || !isRecord(hello.capabilities) || hello.capabilities.bslMultilineStrings === undefined) return undefined;
  const value = hello.capabilities.bslMultilineStrings;
  if (!isRecord(hello.apiVersion) || hello.apiVersion.major !== 1 || !unsigned(hello.apiVersion.minor) || hello.apiVersion.minor < 34
    || !isRecord(value) || value.schemaVersion !== 1 || value.offsetEncoding !== "utf-8" || value.writesOwner !== false
    || !unsigned(value.maxTextBytes) || value.maxTextBytes === 0 || !unsigned(value.maxInlineBytes) || value.maxInlineBytes === 0
    || !unsigned(value.maxContinuations) || value.maxContinuations === 0) invalid();
  return { maxTextBytes: Math.min(value.maxTextBytes, 4_194_304), maxInlineBytes: Math.min(value.maxInlineBytes, 131_072),
    maxContinuations: Math.min(value.maxContinuations, 8192) };
}

/** Allocation acknowledgements survive cancellation so the existing bounded transfer can release them. */
export function withStringText<T>(endpoint: StringEndpoint, text: string, use: (input: QueryTextInput) => Promise<T>, signal?: AbortSignal): Promise<T> {
  return withQueryText(text, { maxSnapshotBytes: endpoint.limits.maxTextBytes, maxInlineBytes: endpoint.limits.maxInlineBytes },
    (method, params) => endpoint.request(method.replace("query/", "language/") as StringMethod, params),
    async bufferId => { await endpoint.request("language/bufferClose", { bufferId }); }, use, signal);
}

/** Validate a whole response before converting its byte boundaries in one pass over the exact buffer. */
export function multilineStrings(value: unknown, text: string, version: number, limits: StringLimits): MultilineString[] {
  const bytes = Buffer.from(text, "utf8");
  if (bytes.toString("utf8") !== text || bytes.length > limits.maxTextBytes || !isRecord(value) || value.schemaVersion !== 1
    || value.version !== String(version) || !isSnapshot(value.sourceSha256)
    || value.sourceSha256 !== createHash("sha256").update(bytes).digest("hex") || !Array.isArray(value.strings)
    || value.strings.length > limits.maxContinuations) invalid();
  const boundaries = new Set<number>();
  const ranges: { start: number; end: number; continuations: number[] }[] = [];
  let previousEnd = 0, count = 0;
  for (const raw of value.strings) {
    if (!isRecord(raw) || !isByteRange(raw.range, bytes.length) || raw.range.start < previousEnd || raw.range.end - raw.range.start < 2
      || bytes[raw.range.start] !== 34 || bytes[raw.range.end - 1] !== 34 || !Array.isArray(raw.continuations) || !raw.continuations.length) invalid();
    const continuations: number[] = [];
    let previous = raw.range.start;
    for (const offset of raw.continuations) {
      if (!unsigned(offset) || offset <= previous || offset >= raw.range.end - 1 || bytes[offset] !== 124 || ++count > limits.maxContinuations) invalid();
      continuations.push(offset); boundaries.add(offset); previous = offset;
    }
    boundaries.add(raw.range.start); boundaries.add(raw.range.end);
    ranges.push({ start: raw.range.start, end: raw.range.end, continuations }); previousEnd = raw.range.end;
  }
  const native = new Map<number, number>();
  let byte = 0, offset = 0;
  for (const point of text) {
    if (boundaries.has(byte)) native.set(byte, offset);
    const code = point.codePointAt(0)!;
    byte += code <= 0x7f ? 1 : code <= 0x7ff ? 2 : code <= 0xffff ? 3 : 4;
    offset += point.length;
  }
  if (boundaries.has(byte)) native.set(byte, offset);
  if (native.size !== boundaries.size) invalid();
  return ranges.map(range => ({ start: native.get(range.start)!, end: native.get(range.end)!,
    continuations: range.continuations.map(position => native.get(position)!) }));
}

function invalid(): never { throw new ExplorerError("protocolInvalid"); }
