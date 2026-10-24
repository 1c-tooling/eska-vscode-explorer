import { isDeepStrictEqual } from "node:util";
import { ExplorerError, isRecord, isToken, isWirePath, type WirePath } from "../protocol.js";
import { querySnapshot } from "./client.js";
import { invalid, isPosition, isSnapshot, unsigned, type QueryPosition } from "./protocol.js";
import { parseDraftPlan, type QueryTextPlan } from "./plan.js";
import type { QueryOwnerFacts } from "./session-protocol.js";

export type ProjectionMethod = "query/projectionOpen" | "query/projectionRead" | "query/projectionMap" | "query/projectionEdits" | "query/projectionClose";
export interface ProjectionLimits { maxBytes: number; maxChunk: number; maxPositions: number; maxEdits: number }
type Transport = (method: ProjectionMethod, params: Record<string, unknown>) => Promise<unknown>;
export interface ProjectedLocation { target: "draft" | "owner"; position: QueryPosition }
export interface ProjectedEdit { range: { start: QueryPosition; end: QueryPosition }; newText: string }
export interface ProjectionHeader {
  projectionId: string; snapshot: string; revision: string; bytes: number; draftBytes: number; draftSnapshot: string;
  source: WirePath; sourceKind: "bsl"; readOnly: true; nativeVersion: string; nativeSnapshot: string;
}

/** A server version alone cannot opt a client into an unadvertised or writable projection contract. */
export function projectionCapabilities(hello: unknown): ProjectionLimits | undefined {
  if (!isRecord(hello) || !isRecord(hello.capabilities) || hello.capabilities.queryProjections === undefined) return undefined;
  const value = hello.capabilities.queryProjections;
  if (!isRecord(hello.apiVersion) || hello.apiVersion.major !== 1 || !unsigned(hello.apiVersion.minor) || hello.apiVersion.minor < 20
    || !isRecord(value) || value.schemaVersion !== 1 || value.writesOwner !== false || value.writesDraft !== false || value.sharedQueryBudget !== true
    || !Array.isArray(value.sourceKinds) || value.sourceKinds.length !== 1 || value.sourceKinds[0] !== "bsl"
    || !unsigned(value.maxSnapshotBytes) || value.maxSnapshotBytes === 0 || !unsigned(value.maxChunkBytes) || value.maxChunkBytes === 0
    || !unsigned(value.maxPositions) || value.maxPositions === 0 || !unsigned(value.maxEdits) || value.maxEdits === 0) invalid();
  return { maxBytes: Math.min(value.maxSnapshotBytes, 8_388_608), maxChunk: Math.min(value.maxChunkBytes, 131_072),
    maxPositions: Math.min(value.maxPositions, 64), maxEdits: Math.min(value.maxEdits, 64) };
}

/** Immutable language input and translations are portable RPC data; no VS Code or LSP client lives in this SDK. */
export class QueryLanguageProjection {
  private closed = false;

  private constructor(private readonly transport: Transport, readonly header: Readonly<ProjectionHeader>,
    readonly ownerText: string, readonly draft: string, private readonly limits: ProjectionLimits) {}

  /** Capture allocation IDs before validation, and release even a malformed or interrupted body response. */
  static async capture(transport: Transport, raw: unknown, limits: ProjectionLimits,
    expected: { owner: QueryOwnerFacts; source: WirePath; draft: string; revision: string }): Promise<QueryLanguageProjection> {
    const id = isRecord(raw) && typeof raw.projectionId === "string" && raw.projectionId ? raw.projectionId : undefined;
    try {
      if (!isRecord(raw) || !id || !isSnapshot(raw.snapshot) || !isToken(raw.revision) || raw.revision === "0"
        || raw.revision !== expected.revision || !isWirePath(raw.source) || !isDeepStrictEqual(raw.source, expected.source)
        || raw.sourceKind !== "bsl" || raw.readOnly !== true || raw.nativeVersion !== expected.owner.version || raw.nativeSnapshot !== expected.owner.snapshot
        || !unsigned(raw.bytes) || raw.bytes > limits.maxBytes || !unsigned(raw.draftBytes) || raw.draftBytes > limits.maxBytes
        || raw.draftBytes !== Buffer.byteLength(expected.draft) || raw.draftSnapshot !== querySnapshot(expected.draft)) invalid();
      const parts: Buffer[] = [];
      let offset = 0;
      do {
        const value = await transport("query/projectionRead", { projectionId: id, snapshot: raw.snapshot, offset, bytes: limits.maxChunk });
        if (!isRecord(value) || value.projectionId !== id || value.snapshot !== raw.snapshot || value.offset !== offset
          || typeof value.data !== "string" || value.data.length > Math.ceil(limits.maxChunk / 3) * 4
          || !unsigned(value.nextOffset) || value.nextOffset > raw.bytes || typeof value.eof !== "boolean") invalid();
        const bytes = Buffer.from(value.data, "base64");
        if (bytes.toString("base64") !== value.data || bytes.length > limits.maxChunk || value.nextOffset !== offset + bytes.length
          || value.eof !== (value.nextOffset === raw.bytes) || (!value.eof && bytes.length === 0)) invalid();
        parts.push(bytes); offset = value.nextOffset;
      } while (offset < raw.bytes);
      const ownerText = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(Buffer.concat(parts));
      if (querySnapshot(ownerText) !== raw.snapshot) invalid();
      return new QueryLanguageProjection(transport, raw as unknown as ProjectionHeader, ownerText, expected.draft, limits);
    } catch (error) {
      if (id) await transport("query/projectionClose", { projectionId: id }).catch(() => {});
      throw error;
    }
  }

  /** Only ESKA translates positions in continuations, escaped quotes and shifted native code. */
  async map(direction: "draftToOwner" | "ownerToDraft" | "ownerTarget", positions: readonly QueryPosition[]): Promise<(ProjectedLocation | undefined)[]> {
    if (positions.length > this.limits.maxPositions || positions.some(position => !isPosition(position))) invalid();
    const value = await this.request("query/projectionMap", { direction, positions });
    if (!isRecord(value) || !Array.isArray(value.positions) || value.positions.length !== positions.length) invalid();
    return value.positions.map(item => {
      if (item === null) return undefined;
      if (!isRecord(item) || !["draft", "owner"].includes(String(item.target)) || !isPosition(item.position)
        || (direction === "draftToOwner" && item.target !== "owner") || (direction === "ownerToDraft" && item.target !== "draft")) invalid();
      return item as unknown as ProjectedLocation;
    });
  }

  /** A language edit set becomes an independently checked draft plan; this method mutates neither source nor checkpoint. */
  async edits(edits: readonly ProjectedEdit[]): Promise<QueryTextPlan> {
    if (edits.length > this.limits.maxEdits) invalid();
    const value = await this.request("query/projectionEdits", { edits });
    return parseDraftPlan(value, this.draft, this.header.draftSnapshot, { maxMappings: this.limits.maxEdits, maxSnapshotBytes: this.limits.maxBytes });
  }

  /** The captured transport owns cleanup even after the selected application or metadata generation changes. */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    const value = await this.transport("query/projectionClose", { projectionId: this.header.projectionId });
    if (!isRecord(value) || typeof value.released !== "boolean") invalid();
  }

  /** A released view cannot accidentally send a request with a recycled projection identifier. */
  private async request(method: ProjectionMethod, params: Record<string, unknown>): Promise<unknown> {
    if (this.closed) throw new ExplorerError("obsolete");
    return this.transport(method, { projectionId: this.header.projectionId, snapshot: this.header.snapshot, ...params });
  }
}
