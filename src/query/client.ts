import { createHash } from "node:crypto";
import type { Connection } from "../connection.js";
import { ExplorerError, isRecord, isToken, isWirePath, type WirePath } from "../protocol.js";
import type { NodeId, ProjectTree } from "../tree.js";
import { invalid, isSnapshot, isPosition, parseQueryHeader, parseQueryValue, unsigned,
  type CommentDecision, type QueryCapabilities, type QueryHeader, type QueryIdentity, type QueryPlan,
  type QueryPosition, type QueryValue } from "./protocol.js";
import { parsePlan } from "./plan.js";

export interface QueryOwner {
  node: NodeId;
  source: WirePath;
  version: string;
  text: string;
  application?: string;
}
export interface QueryBinding {
  documentId: string;
  version: string;
  snapshot: string;
  contextFingerprint: string;
}

/** Hash exactly the text submitted from the owner editor, including any retained BOM. */
export function querySnapshot(text: string): string { return createHash("sha256").update(text, "utf8").digest("hex"); }

/** Query RPCs never retry a request under a different metadata generation. */
export class QueryClient {
  constructor(private readonly connection: Connection, readonly sessionId: string,
    private readonly project: ProjectTree, readonly limits: QueryCapabilities) {}

  /** Retain the exact owner buffer; disk bytes are an independent external-change guard. */
  async open(owner: QueryOwner, signal?: AbortSignal): Promise<QueryDocument> {
    if (!isToken(owner.version) || owner.version === "0") invalid();
    const generation = this.project.info.generation;
    const params = { node: owner.node, source: owner.source, version: owner.version,
      ...(owner.application === undefined ? {} : { application: owner.application }) };
    let opened: Record<string, unknown> | undefined;
    try {
      await this.withText(owner.text, generation, async input => {
        assertActive(signal);
        // Allocation acknowledgements must survive cancellation so their IDs can be released.
        opened = await this.request("query/open", { ...params, ...input }, generation);
      }, signal);
      assertActive(signal);
      this.checkGeneration(generation);
      if (!opened || typeof opened.documentId !== "string" || !opened.documentId || opened.version !== owner.version
        || opened.snapshot !== querySnapshot(owner.text) || !isSnapshot(opened.contextFingerprint)
        || !isSnapshot(opened.diskSnapshot) || !isWirePath(opened.source) || typeof opened.writable !== "boolean"
        || typeof opened.limitedContext !== "boolean" || !(opened.application === null || typeof opened.application === "string")
        || !["dataCompositionSchema", "form", "bsl"].includes(String(opened.sourceKind))) invalid();
      return new QueryDocument(this, generation, owner.text, {
        documentId: opened.documentId, version: owner.version, snapshot: opened.snapshot,
        contextFingerprint: opened.contextFingerprint,
      }, opened.diskSnapshot, opened.source, opened.sourceKind as QueryDocument["sourceKind"],
      opened.application, opened.writable, opened.limitedContext);
    } catch (error) {
      if (opened && typeof opened.documentId === "string") {
        try { await this.release("query/close", "documentId", opened.documentId, generation); }
        catch { /* The original failure is authoritative; workspace teardown also releases retained entries. */ }
      }
      throw error;
    }
  }

  /** Validate one immutable metadata context without injecting tree retry semantics. */
  async request(method: string, params: Record<string, unknown>, generation: string, signal?: AbortSignal): Promise<Record<string, unknown>> {
    this.checkGeneration(generation);
    const value = await this.connection.request(this.sessionId, method,
      { ...params, projectId: this.project.info.projectId, generation }, signal);
    if (!isRecord(value) || value.sessionId !== this.sessionId || value.projectId !== this.project.info.projectId
      || value.generation !== generation) invalid();
    if (method !== "query/open" && method !== "query/bufferBegin") this.checkGeneration(generation);
    return value;
  }

  /** Cleanup remains legal after a generation change and does not depend on a successful refresh. */
  async release(method: "query/close" | "query/bufferClose", field: "documentId" | "bufferId", id: string, generation: string): Promise<void> {
    const value = await this.connection.request(this.sessionId, method,
      { [field]: id, projectId: this.project.info.projectId, generation });
    if (!isRecord(value) || typeof value.released !== "boolean") invalid();
  }

  /** Sequential UTF-8 chunks stay below the frame bound even when JSON escapes every character. */
  async withText<T>(text: string, generation: string, use: (input: { text: string } | { bufferId: string }) => Promise<T>,
    signal?: AbortSignal): Promise<T> {
    assertActive(signal);
    const bytes = Buffer.from(text, "utf8");
    if (bytes.toString("utf8") !== text) throw new ExplorerError("sourceChanged");
    if (bytes.length > this.limits.maxSnapshotBytes) throw new ExplorerError("resourceLimit");
    if (bytes.length <= this.limits.maxInlineBytes) return use({ text });
    let bufferId: string | undefined;
    try {
      const begun = await this.request("query/bufferBegin", { bytes: bytes.length, snapshot: querySnapshot(text) }, generation);
      if (typeof begun.bufferId === "string" && begun.bufferId) bufferId = begun.bufferId;
      if (!bufferId || begun.receivedBytes !== 0 || begun.ready !== false) invalid();
      for (let offset = 0; offset < bytes.length;) {
        assertActive(signal);
        let end = Math.min(offset + this.limits.maxInlineBytes, bytes.length);
        while (end < bytes.length && (bytes[end]! & 0xc0) === 0x80) end--;
        if (end === offset) throw new ExplorerError("resourceLimit");
        const appended = await this.request("query/bufferAppend", { bufferId, offset, text: bytes.toString("utf8", offset, end) }, generation);
        if (appended.bufferId !== bufferId || appended.receivedBytes !== end || appended.ready !== (end === bytes.length)) invalid();
        offset = end;
      }
      assertActive(signal);
      return await use({ bufferId });
    } finally {
      if (bufferId) await this.release("query/bufferClose", "bufferId", bufferId, generation);
    }
  }

  /** A changed member or permission refresh requires reopening from a preserved draft. */
  private checkGeneration(generation: string): void {
    if (this.project.info.generation !== generation || this.project.info.requiresReopen || this.project.info.requiresRefresh) {
      throw new ExplorerError("sourceChanged");
    }
  }
}

/** One backend document is shared by discovery and all views of its owner session. */
export class QueryDocument {
  private closed = false;

  constructor(private readonly client: QueryClient, readonly generation: string, readonly original: string,
    readonly binding: Readonly<QueryBinding>, readonly diskSnapshot: string, readonly source: WirePath,
    readonly sourceKind: "dataCompositionSchema" | "form" | "bsl", readonly application: string | null,
    readonly writable: boolean, readonly limitedContext: boolean) {}

  /** Paginate bounded headers, rejecting loops and duplicate logical identities. */
  async list(signal?: AbortSignal): Promise<QueryHeader[]> {
    const queries: QueryHeader[] = [];
    const keys = new Set<string>();
    for (let offset = 0;;) {
      const result = await this.request("query/list", { offset, limit: this.client.limits.maxListItems }, signal);
      if (!Array.isArray(result.queries) || result.queries.length > this.client.limits.maxListItems) invalid();
      for (const value of result.queries) {
        const header = parseQueryHeader(value, Buffer.byteLength(this.original));
        if (header.identity.kind === "bslLiteral" || keys.has(queryKey(header.identity))) invalid();
        keys.add(queryKey(header.identity)); queries.push(header);
      }
      if (queries.length > this.client.limits.maxXmlQueries) invalid();
      if (result.nextOffset === null) return queries;
      if (!unsigned(result.nextOffset) || result.nextOffset !== offset + result.queries.length || result.nextOffset <= offset) invalid();
      offset = result.nextOffset;
    }
  }

  /** Read XML by identity or resolve the first BSL literal from its owner cursor. */
  async read(selection: { query: QueryIdentity } | { at: QueryPosition }, signal?: AbortSignal): Promise<QueryValue> {
    const result = await this.request("query/read", selection, signal);
    const query = parseQueryValue(result.query, Buffer.byteLength(this.original), this.client.limits);
    if ("query" in selection && queryKey(query.identity) !== queryKey(selection.query)) invalid();
    return query;
  }

  /** Plan only: the caller must recheck the live editor version before applying replacements. */
  async plan(query: QueryIdentity, text: string, comments: CommentDecision[] = [],
    options: { signal?: AbortSignal; lineEnding?: "lf" | "crlf" } = {}): Promise<QueryPlan> {
    const { signal, lineEnding } = options;
    if (lineEnding !== undefined && !this.client.limits.editorLineEndings) throw new ExplorerError("incompatible");
    const result = await this.client.withText(text, this.generation, async input => {
      return this.request("query/plan", { query, ...input, comments, ...(lineEnding === undefined ? {} : { lineEnding }) }, signal);
    }, signal);
    return parsePlan(result, this.original, this.binding.snapshot, query, this.client.limits);
  }

  /** Map the frozen original revision; a projected draft has its own returned map. */
  async map(query: QueryIdentity, direction: "queryToSource" | "sourceToQuery", positions: QueryPosition[],
    affinity: "before" | "after" = "after", signal?: AbortSignal): Promise<(QueryPosition | null)[]> {
    if (positions.length > this.client.limits.maxMappingPositions) throw new ExplorerError("resourceLimit");
    const result = await this.request("query/map", { query, direction, positions, affinity }, signal);
    if (!Array.isArray(result.positions) || result.positions.length !== positions.length
      || !result.positions.every(position => position === null || isPosition(position))) invalid();
    return result.positions as (QueryPosition | null)[];
  }

  /** Release stale-generation documents without discarding the caller's draft. */
  async close(): Promise<void> {
    if (this.closed) return;
    await this.client.release("query/close", "documentId", this.binding.documentId, this.generation);
    this.closed = true;
  }

  /** Every read and plan must echo the complete original binding. */
  private async request(method: string, params: Record<string, unknown>, signal?: AbortSignal): Promise<Record<string, unknown>> {
    if (this.closed) throw new ExplorerError("obsolete");
    const result = await this.client.request(method, { ...params, ...this.binding }, this.generation, signal);
    if (Object.entries(this.binding).some(([key, value]) => result[key] !== value) || typeof result.writable !== "boolean") invalid();
    return result;
  }
}

/** Identity serialization does not depend on server property order. */
export function queryKey(query: QueryIdentity): string {
  return JSON.stringify(query.kind === "dataSet" ? [query.kind, ...query.path]
    : query.kind === "dynamicList" ? [query.kind, query.name, query.id] : [query.kind, query.range.start, query.range.end]);
}

/** Check caller cancellation between acknowledged allocations, preserving cleanup handles. */
function assertActive(signal?: AbortSignal): void { if (signal?.aborted) throw new ExplorerError("cancelled"); }
