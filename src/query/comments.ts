import { isRecord, isToken } from "../protocol.js";
import { invalid, isPosition, isSnapshot, unsigned, type QueryPosition } from "./protocol.js";

export interface SourceCommentState {
  revision: string; snapshot: string; needsDecision: boolean; lineStartsOnly: boolean;
  comments: { comment: number; text: string; originalQueryOffset: number; originalQueryPosition: QueryPosition | null }[];
  positions: { position: QueryPosition; queryOffset: number | null }[];
}

/** Source anchors and UTF-16 destinations are checked by ESKA; this SDK validates only their portable wire shape. */
export function sourceCommentState(raw: unknown, expected: { revision: string; snapshot: string; positions: readonly QueryPosition[]; baseBytes: number; draftBytes: number }): SourceCommentState {
  if (!isRecord(raw) || !isToken(raw.revision) || raw.revision !== expected.revision || !isSnapshot(raw.snapshot) || raw.snapshot !== expected.snapshot
    || typeof raw.needsDecision !== "boolean" || typeof raw.lineStartsOnly !== "boolean" || !Array.isArray(raw.comments) || raw.comments.length > 8192
    || !Array.isArray(raw.positions) || raw.positions.length !== expected.positions.length || raw.positions.length > 64) invalid();
  let bytes = 0;
  for (const [index, comment] of raw.comments.entries()) {
    if (!isRecord(comment) || comment.comment !== index || typeof comment.text !== "string" || !unsigned(comment.originalQueryOffset)
      || comment.originalQueryOffset > expected.baseBytes || !(comment.originalQueryPosition === null || isPosition(comment.originalQueryPosition))) invalid();
    bytes += Buffer.byteLength(comment.text); if (bytes > 8_388_608) invalid();
  }
  for (const [index, value] of raw.positions.entries()) {
    const point = expected.positions[index]!;
    if (!isRecord(value) || !isPosition(value.position) || value.position.line !== point.line || value.position.character !== point.character
      || !(value.queryOffset === null || (unsigned(value.queryOffset) && value.queryOffset <= expected.draftBytes))) invalid();
  }
  return raw as unknown as SourceCommentState;
}
