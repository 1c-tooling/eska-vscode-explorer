import { createHash } from "node:crypto";
import { isRecord } from "../protocol.js";
import { invalid, isByteRange, isPosition, isSnapshot, parseQueryValue,
  type QueryCapabilities, type QueryIdentity, type QueryPlan, type QueryPosition } from "./protocol.js";

/** Independently verify source coordinates and output bytes before a plan reaches WorkspaceEdit. */
export function parsePlan(value: unknown, original: string, snapshot: string, identity: QueryIdentity, limits: QueryCapabilities): QueryPlan {
  const { output } = checkedTextPlan(value, original, snapshot, limits);
  if (!isRecord(value)) invalid();
  const projected = parseQueryValue(value.projectedQuery, Buffer.byteLength(output), limits);
  // A BSL range can move in the projection, but must not replace the session's original identity.
  if (projected.identity.kind !== identity.kind || (identity.kind === "dataSet"
    && (projected.identity.kind !== "dataSet" || JSON.stringify(projected.identity.path) !== JSON.stringify(identity.path)))
    || (identity.kind === "dynamicList" && (projected.identity.kind !== "dynamicList"
      || projected.identity.id !== identity.id || projected.identity.name !== identity.name))) invalid();
  return value as unknown as QueryPlan;
}

export type QueryTextPlan = Omit<QueryPlan, "projectedQuery">;
type TextLimits = Pick<QueryCapabilities, "maxMappings" | "maxSnapshotBytes">;

/** Draft plans use the same complete byte/UTF-16/output checks as source plans, without a fabricated source identity. */
export function parseDraftPlan(value: unknown, original: string, snapshot: string, limits: TextLimits): QueryTextPlan {
  if (!isRecord(value) || value.inputSnapshot !== snapshot) invalid();
  return checkedTextPlan(value, original, snapshot, limits).plan;
}

/** Validate native edit coordinates once for every consumer of a backend text plan. */
function checkedTextPlan(value: unknown, original: string, snapshot: string, limits: TextLimits): { plan: QueryTextPlan; output: string } {
  const bytes = Buffer.from(original, "utf8");
  if (!isRecord(value) || typeof value.noOp !== "boolean" || !isSnapshot(value.outputSnapshot)
    || !Array.isArray(value.replacements) || value.replacements.length > limits.maxMappings
    || value.noOp !== (value.replacements.length === 0)) invalid();
  let end = 0;
  let outputBytes = bytes.length;
  const parts: Buffer[] = [];
  const position = bytePositions(bytes);
  for (const replacement of value.replacements) {
    if (!isRecord(replacement) || !isByteRange(replacement.range, bytes.length) || replacement.range.start < end
      || typeof replacement.text !== "string" || !isRecord(replacement.rangeUtf16)
      || !samePosition(replacement.rangeUtf16.start, position(replacement.range.start))
      || !samePosition(replacement.rangeUtf16.end, position(replacement.range.end))) invalid();
    const text = Buffer.from(replacement.text, "utf8");
    if (text.toString("utf8") !== replacement.text) invalid();
    outputBytes += text.length - (replacement.range.end - replacement.range.start);
    parts.push(bytes.subarray(end, replacement.range.start), text);
    end = replacement.range.end;
  }
  if (outputBytes > limits.maxSnapshotBytes) invalid();
  parts.push(bytes.subarray(end));
  const output = Buffer.concat(parts).toString("utf8");
  if (createHash("sha256").update(output, "utf8").digest("hex") !== value.outputSnapshot
    || (value.noOp && value.outputSnapshot !== snapshot)) invalid();
  return { plan: value as unknown as QueryTextPlan, output };
}

/** Walk sorted boundaries once, rejecting UTF-8 and CRLF interiors without quadratic prefix scans. */
function bytePositions(bytes: Buffer): (target: number) => QueryPosition {
  let offset = 0;
  let line = 0;
  let character = 0;
  return target => {
    if (target < offset) invalid();
    while (offset < target) {
      const first = bytes[offset]!;
      if (first === 13 || first === 10) {
        offset += first === 13 && bytes[offset + 1] === 10 ? 2 : 1;
        if (offset > target) invalid();
        line++; character = 0;
      } else {
        const width = first < 0x80 ? 1 : first < 0xe0 ? 2 : first < 0xf0 ? 3 : 4;
        offset += width;
        if (offset > target) invalid();
        character += width === 4 ? 2 : 1;
      }
    }
    return { line, character };
  };
}

/** Compare structured coordinates without allowing null or partially specified positions. */
function samePosition(value: unknown, expected: QueryPosition): boolean {
  return isPosition(value) && value.line === expected.line && value.character === expected.character;
}
