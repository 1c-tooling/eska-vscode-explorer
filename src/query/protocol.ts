import { ExplorerError, isRecord } from "../protocol.js";

export const QUERY_LIMITS = {
  maxSnapshotBytes: 8_388_608, maxInlineBytes: 131_072, maxRetainedBytes: 33_554_432,
  maxDocuments: 16, maxRetainedEntries: 64, maxMappingPositions: 64, maxListItems: 64,
  maxXmlQueries: 1024, maxMappings: 65_536, maxSourceComments: 8192,
} as const;
export type QueryCapabilities = { readonly [K in keyof typeof QUERY_LIMITS]: number };
export interface ByteRange { start: number; end: number }
export interface QueryPosition { line: number; character: number }
export interface PositionRange { start: QueryPosition; end: QueryPosition }
export type QueryIdentity = { kind: "dataSet"; path: string[] }
  | { kind: "dynamicList"; name: string; id: string }
  | { kind: "bslLiteral"; range: ByteRange };
export interface QueryHeader { identity: QueryIdentity; sourceRange: ByteRange }
export interface QueryValue extends QueryHeader {
  text: string;
  sourceRangeUtf16: { start: QueryPosition | null; end: QueryPosition | null };
  map: {
    encoding: "utf-8";
    spans: { query: ByteRange; source: ByteRange; direct: boolean }[];
    anchors: { startBefore: number | null; startAfter: number | null; endBefore: number | null; endAfter: number | null };
  };
  comments: { comment: number; source: ByteRange; queryOffset: number; text: string }[];
}
export interface CommentDecision { comment: number; queryOffset: number | null }
export interface QueryPlan {
  noOp: boolean;
  outputSnapshot: string;
  replacements: { range: ByteRange; rangeUtf16: PositionRange; text: string }[];
  projectedQuery: QueryValue;
}

/** Optional capabilities keep API 1.12 tree connections usable without query commands. */
export function queryCapabilities(hello: unknown): QueryCapabilities | undefined {
  if (!isRecord(hello) || !isRecord(hello.capabilities) || hello.capabilities.queryEditing === undefined) return undefined;
  const value = hello.capabilities.queryEditing;
  if (!isRecord(hello.apiVersion) || hello.apiVersion.major !== 1 || typeof hello.apiVersion.minor !== "number"
    || hello.apiVersion.minor < 13 || !isRecord(value) || value.schemaVersion !== 1
    || value.planOnly !== true || value.writesOwner !== false || !Array.isArray(value.sourceKinds)
    || !["dataCompositionSchema", "form", "bsl"].every(kind => (value.sourceKinds as unknown[]).includes(kind))) invalid();
  const limits = { ...QUERY_LIMITS } as QueryCapabilities;
  for (const key of Object.keys(QUERY_LIMITS) as (keyof QueryCapabilities)[]) {
    if (!unsigned(value[key]) || value[key] === 0) invalid();
    Object.assign(limits, { [key]: Math.min(value[key], QUERY_LIMITS[key]) });
  }
  return limits;
}

/** A hash identifies UTF-8 bytes, never a locale-sensitive representation. */
export function isSnapshot(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}

/** Reject negative, fractional and imprecise protocol coordinates. */
export function unsigned(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

/** Byte ranges are checked against the exact buffer that their binding identifies. */
export function isByteRange(value: unknown, bytes: number): value is ByteRange {
  return isRecord(value) && unsigned(value.start) && unsigned(value.end) && value.start <= value.end && value.end <= bytes;
}

/** UTF-16 positions stay structured until the owning editor checks its current version. */
export function isPosition(value: unknown): value is QueryPosition {
  return isRecord(value) && unsigned(value.line) && unsigned(value.character);
}

/** XML identities carry the complete union path; BSL coordinates remain snapshot-scoped. */
export function isQueryIdentity(value: unknown, bytes: number): value is QueryIdentity {
  if (!isRecord(value)) return false;
  switch (value.kind) {
    case "dataSet": return Array.isArray(value.path) && value.path.length > 0 && value.path.length <= 64
      && value.path.every(part => typeof part === "string" && part.length > 0);
    case "dynamicList": return typeof value.name === "string" && value.name.length > 0
      && typeof value.id === "string" && value.id.length > 0;
    case "bslLiteral": return isByteRange(value.range, bytes) && value.range.start < value.range.end;
    default: return false;
  }
}

/** Tree discovery carries identities and ranges without duplicating all query maps. */
export function parseQueryHeader(value: unknown, bytes: number): QueryHeader {
  if (!isRecord(value) || !isQueryIdentity(value.identity, bytes) || !isByteRange(value.sourceRange, bytes)) invalid();
  return value as unknown as QueryHeader;
}

/** Validate the bounded map before it can address an editor or a language projection. */
export function parseQueryValue(value: unknown, bytes: number, limits: QueryCapabilities): QueryValue {
  parseQueryHeader(value, bytes);
  if (!isRecord(value) || typeof value.text !== "string" || Buffer.byteLength(value.text) > limits.maxSnapshotBytes
    || !isRecord(value.sourceRangeUtf16) || !nullablePosition(value.sourceRangeUtf16.start)
    || !nullablePosition(value.sourceRangeUtf16.end) || !isRecord(value.map) || value.map.encoding !== "utf-8"
    || !Array.isArray(value.map.spans) || value.map.spans.length > limits.maxMappings || !isRecord(value.map.anchors)
    || !["startBefore", "startAfter", "endBefore", "endAfter"].every(key => {
      const map = value.map as Record<string, unknown>;
      const point = (map.anchors as Record<string, unknown>)[key]; return point === null || (unsigned(point) && point <= bytes);
    }) || !Array.isArray(value.comments) || value.comments.length > limits.maxSourceComments) invalid();
  const queryBytes = Buffer.byteLength(value.text);
  for (const span of value.map.spans) {
    if (!isRecord(span) || !isByteRange(span.query, queryBytes) || !isByteRange(span.source, bytes)
      || typeof span.direct !== "boolean" || (span.direct && span.query.end - span.query.start !== span.source.end - span.source.start)) invalid();
  }
  for (const [index, comment] of value.comments.entries()) {
    if (!isRecord(comment) || comment.comment !== index || !isByteRange(comment.source, bytes)
      || !unsigned(comment.queryOffset) || comment.queryOffset > queryBytes || typeof comment.text !== "string") invalid();
  }
  return value as unknown as QueryValue;
}

/** An invalid server payload is a protocol failure, never permission for a best-effort edit. */
export function invalid(): never { throw new ExplorerError("protocolInvalid"); }

/** Null marks a source boundary that has no valid editor coordinate. */
function nullablePosition(value: unknown): boolean { return value === null || isPosition(value); }
