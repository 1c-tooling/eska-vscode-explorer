import { ExplorerError, isRecord, isToken } from "../protocol.js";
import { querySnapshot, type QueryDocument } from "./client.js";
import { QueryLanguageProjection } from "./projections.js";
import { parsePlan } from "./plan.js";
import { invalid, type CommentDecision, type QueryCapabilities, type QueryIdentity } from "./protocol.js";
import { QueryRecovery } from "./recovery.js";
import type { RecoveryEndpoint } from "./recovery-protocol.js";
import { querySessionHeader, type QueryOwnerFacts, type QueryPreparedSession, type QuerySessionHeader,
  type QuerySessionMethod, type QuerySessionTransport } from "./session-protocol.js";

export interface QuerySessionContext { sessionId: string; projectId: string; generation: string }

/** A process-bound transport delegates source decisions to ESKA and storage ordering to common recovery. */
export class QuerySessions {
  private readonly transport: QuerySessionTransport;

  constructor(private readonly endpoint: RecoveryEndpoint, readonly recovery: QueryRecovery,
    private readonly context: () => QuerySessionContext, readonly limits: QueryCapabilities) {
    if (!endpoint.sessions) throw new ExplorerError("incompatible");
    this.transport = endpoint.sessions;
  }

  /** The language adapter can use only an explicitly negotiated immutable projection contract. */
  get projectionLimits() { return this.endpoint.sessions?.capabilities.projections; }

  /** ESKA publishes the initial owner/base/draft and consumes the transient checked document handle. */
  async open(document: QueryDocument, id: string, query: QueryIdentity,
    userReadOnly: boolean): Promise<QuerySourceSession> {
    const header = await this.recovery.withCheckpoint(id, async storeId => {
      return this.header(await this.request("query/sessionOpen", { documentId: document.binding.documentId,
        storeId, id, query, format: "editor", userReadOnly }), storeId, id);
    }, true);
    return new QuerySourceSession(this, header);
  }

  /** Restoring a handle never resumes it or applies source text; the caller must request explicit resume. */
  async restore(id: string): Promise<QuerySourceSession> {
    const header = await this.recovery.withCheckpoint(id, async (storeId, checkpoint) => {
      if (!checkpoint) throw new ExplorerError("obsolete");
      return this.header(await this.request("query/sessionRestore", { storeId, id,
        revision: checkpoint.revision, format: "editor" }), storeId, id);
    });
    return new QuerySourceSession(this, header);
  }

  /** Validate only the native process/context envelope; metadata refresh is never an automatic query retry. */
  async request(method: QuerySessionMethod, params: Record<string, unknown>): Promise<unknown> {
    const context = this.context();
    const value = await this.transport.request(method, { ...context, ...params });
    if (!isRecord(value)) invalid();
    if (!["query/sessionClose", "query/sessionGet", "query/projectionRead", "query/projectionMap", "query/projectionEdits", "query/projectionClose"].includes(method)
      && (value.sessionId !== context.sessionId || value.projectId !== context.projectId || !isToken(value.generation)
        || (!["query/sessionApplied", "query/sessionAbort"].includes(method) && value.generation !== context.generation))) invalid();
    return value;
  }

  /** A source handle cannot borrow another checkpoint or a later recovery-store selection. */
  header(value: unknown, storeId: string, id: string, handle?: string): QuerySessionHeader {
    const header = querySessionHeader(value, this.endpoint.capabilities);
    if (header.id !== id || header.storeId !== storeId || (handle !== undefined && header.querySessionId !== handle)) invalid();
    return header;
  }
}

/** Cached headers describe backend state; every transition is acknowledged by the same process before publication. */
export class QuerySourceSession {
  private closed = false;

  constructor(private readonly client: QuerySessions, private current: QuerySessionHeader) {}

  /** Headers are presentation snapshots, not permission to bypass a later source preflight. */
  get header(): Readonly<QuerySessionHeader> { return this.current; }

  /** Native input is transported as an independent draft, never as a replacement source binding. */
  get record(): ReturnType<QueryRecovery["record"]> { return this.client.recovery.record(this.current.id); }

  /** A language view is allocated from the acknowledged draft without issuing a source application intent. */
  async projection(owner: QueryOwnerFacts): Promise<QueryLanguageProjection> {
    const limits = this.client.projectionLimits;
    if (!limits) throw new ExplorerError("incompatible");
    const result = await this.client.recovery.withCheckpoint(this.current.id, async storeId => {
      const current = await this.call("query/sessionGet", storeId, {});
      this.current = current;
      const draft = this.record.draft.replaceAll("\r\n", "\n").replaceAll("\r", "\n");
      const value = await this.client.request("query/projectionOpen", { querySessionId: current.querySessionId,
        revision: current.revision, owner });
      const projection = await QueryLanguageProjection.capture((method, params) => this.client.request(method, params), value, limits,
        { owner, source: this.record.source, draft, revision: current.revision });
      return { record: current.record, projection };
    });
    return result.projection;
  }

  /** The core owns explicit recovery and source rebinding, including an already applied durable intent. */
  async resume(owner: QueryOwnerFacts): Promise<void> {
    this.current = await this.transition(async (storeId, current) => this.call("query/sessionResume", storeId,
      { revision: current.revision, owner }));
  }

  /** A save of an older native SDBL revision cannot silently apply a newer acknowledged draft. */
  async prepare(owner: QueryOwnerFacts, draft: string, comments: CommentDecision[] = [],
    lineEnding?: "lf" | "crlf"): Promise<QueryPreparedSession["plan"]> {
    if (lineEnding !== undefined && !this.client.limits.editorLineEndings) throw new ExplorerError("incompatible");
    let original: ReturnType<QueryRecovery["record"]> | undefined;
    const result = await this.transition(async (storeId, current) => {
      original = this.record;
      if (current.record.parts.draft.snapshot !== querySnapshot(draft)
        || current.record.parts.draft.bytes !== Buffer.byteLength(draft)) {
        throw new ExplorerError("requestFailed", "query_failed", { reason: "stale_draft" });
      }
      return this.call("query/sessionPrepare", storeId, { revision: current.revision, owner, comments,
        ...(lineEnding ? { lineEnding } : {}) });
    });
    this.current = result;
    const raw = result as unknown as Record<string, unknown>;
    if (!original || !result.applyPending || !isRecord(raw.plan) || !isToken(raw.plan.applyToken)
      || raw.plan.applyToken === "0" || typeof raw.plan.saveOwner !== "boolean") invalid();
    if (querySnapshot(original.ownerText) !== owner.snapshot) throw new ExplorerError("sourceChanged");
    const plan = parsePlan(raw.plan, original.ownerText, owner.snapshot, original.identity, this.client.limits);
    const prepared = result.record.prepared;
    if (!prepared || prepared.applyToken !== raw.plan.applyToken || prepared.saveOwner !== raw.plan.saveOwner
      || prepared.noOp !== plan.noOp || prepared.parts.output.snapshot !== plan.outputSnapshot || prepared.format !== result.format
      || (raw.plan.saveOwner && (plan.noOp || owner.isDirty))) invalid();
    return { ...plan, applyToken: raw.plan.applyToken, saveOwner: raw.plan.saveOwner };
  }

  /** Exact native results advance owner/base in ESKA; pending newer native input is rebased by the shared queue. */
  async applied(applyToken: string, owner: QueryOwnerFacts): Promise<void> {
    this.current = await this.transition(async storeId => this.call("query/sessionApplied", storeId, { applyToken, owner }));
  }

  /** Abort is safe before native mutation; an uncertain native result keeps its durable intent for explicit recovery. */
  async abort(applyToken: string): Promise<void> {
    this.current = await this.transition(async storeId => this.call("query/sessionAbort", storeId, { applyToken }));
  }

  /** Closing frees only this backend handle; its checkpoint and unfinished intent remain recoverable. */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    const result = await this.client.request("query/sessionClose", { querySessionId: this.current.querySessionId });
    if (!isRecord(result) || typeof result.released !== "boolean"
      || !(result.releasedOwnerLock === null || (isToken(result.releasedOwnerLock) && result.releasedOwnerLock !== "0"))
      || !(result.userReadOnly === null || typeof result.userReadOnly === "boolean")) invalid();
  }

  /** Refresh the session revision after draft acknowledgements without reconstructing lifecycle decisions locally. */
  private async transition<T extends QuerySessionHeader>(action: (storeId: string, current: QuerySessionHeader) => Promise<T>): Promise<T> {
    if (this.closed) throw new ExplorerError("obsolete");
    return this.client.recovery.withCheckpoint(this.current.id, async storeId => {
      const current = await this.call("query/sessionGet", storeId, {});
      return action(storeId, current);
    });
  }

  /** Every reply identifies the same source handle and the same private checkpoint. */
  private async call(method: QuerySessionMethod, storeId: string, params: Record<string, unknown>): Promise<QuerySessionHeader> {
    if (this.closed) throw new ExplorerError("obsolete");
    return this.client.header(await this.client.request(method, { ...params, querySessionId: this.current.querySessionId }),
      storeId, this.current.id, this.current.querySessionId);
  }
}
