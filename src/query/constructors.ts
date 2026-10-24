import { ExplorerError, isRecord, isToken } from "../protocol.js";
import { querySnapshot } from "./client.js";
import { invalid, isByteRange, isSnapshot, unsigned, type ByteRange } from "./protocol.js";
import { parseDraftPlan, type QueryTextPlan } from "./plan.js";

export const CLAUSES = ["fields", "sources", "joins", "conditions", "group", "order"] as const;
export type ConstructorClauseKind = typeof CLAUSES[number];
export type ConstructorMethod = "query/constructorOpen" | "query/constructorPlan" | "query/constructorModel" | "query/constructorAction" | "query/constructorFinish" | "query/constructorCancel";
export interface ConstructorLimits { maxExpression: number; maxModel: number }
export interface ConstructorSelection { statement: number; clause: number; item: number }
export type ConstructorAction = { kind: "append"; statement: number; clause: ConstructorClauseKind; text: string; join?: "inner" | "left" | "right" | "full" }
  | { kind: "replace"; selection: ConstructorSelection; text: string }
  | { kind: "remove"; selection: ConstructorSelection; comments?: "keep" | "discard" }
  | { kind: "move"; selection: ConstructorSelection; to: number };
export interface ConstructorItem {
  index: number; range: ByteRange; preview: string; expression: string | null; comments: number; removable: boolean; movable: boolean;
  unavailable: { replace: string | null; remove: string | null; move: string | null };
}
export interface ConstructorClause { index: number; kind: ConstructorClauseKind; header: string; items: ConstructorItem[] }
export interface ConstructorStatement {
  index: number; range: ByteRange; unavailable: string | null; preview: string; clauses: ConstructorClause[];
  append: { kind: ConstructorClauseKind; unavailable: string | null }[];
}
export interface ConstructorModel {
  id: string; revision: string; snapshot: string; text: string; bytes: number; writable: boolean; statements: ConstructorStatement[];
}
type Transport = (method: ConstructorMethod, params: Record<string, unknown>) => Promise<unknown>;

/** An older backend cannot opt into a constructor by version alone or an incomplete writable capability. */
export function constructorCapabilities(hello: unknown): ConstructorLimits | undefined {
  if (!isRecord(hello) || !isRecord(hello.capabilities) || hello.capabilities.queryConstructor === undefined) return undefined;
  const value = hello.capabilities.queryConstructor;
  if (!isRecord(hello.apiVersion) || hello.apiVersion.major !== 1 || !unsigned(hello.apiVersion.minor) || hello.apiVersion.minor < 21
    || !isRecord(value) || value.schemaVersion !== 1 || value.writesOwner !== false || value.writesDraft !== true
    || value.explicitFinish !== true || value.exclusiveDraft !== true || value.lossless !== true || value.nativeDraftPlan !== true || value.sourceCommentPositions !== true
    || value.sharedQueryBudget !== true || !Array.isArray(value.clauses) || value.clauses.length !== CLAUSES.length
    || !unsigned(value.maxExpressionBytes) || value.maxExpressionBytes === 0
    || !unsigned(value.maxModelBytes) || value.maxModelBytes === 0) invalid();
  if (!value.clauses.every((kind, index) => kind === CLAUSES[index])) invalid();
  return { maxExpression: Math.min(value.maxExpressionBytes, 16_384), maxModel: Math.min(value.maxModelBytes, 33_554_432) };
}

/** Validate only transport shape and snapshot bytes; parsing, eligibility and text generation remain in ESKA. */
export function constructorModel(raw: unknown, limits: ConstructorLimits, id?: string): ConstructorModel {
  if (!isRecord(raw) || !isToken(raw.id) || raw.id === "0" || (id !== undefined && raw.id !== id)
    || !isToken(raw.revision) || raw.revision === "0" || !isSnapshot(raw.snapshot) || typeof raw.text !== "string"
    || !unsigned(raw.bytes) || raw.bytes > 8_388_608 || Buffer.byteLength(raw.text) !== raw.bytes || querySnapshot(raw.text) !== raw.snapshot
    || Buffer.from(raw.text).toString() !== raw.text || typeof raw.writable !== "boolean"
    || !Array.isArray(raw.statements) || raw.statements.length > 256 || Buffer.byteLength(JSON.stringify(raw)) > limits.maxModel) invalid();
  let entries = 0;
  for (const [index, statement] of raw.statements.entries()) {
    if (!isRecord(statement) || statement.index !== index || !isByteRange(statement.range, raw.bytes)
      || !reason(statement.unavailable) || typeof statement.preview !== "string" || !Array.isArray(statement.clauses)
      || !Array.isArray(statement.append) || statement.append.length !== CLAUSES.length) invalid();
    for (const [index, option] of statement.append.entries()) {
      if (!isRecord(option) || option.kind !== CLAUSES[index] || !reason(option.unavailable)) invalid();
    }
    for (const [index, clause] of statement.clauses.entries()) {
      if (!isRecord(clause) || clause.index !== index || !CLAUSES.includes(clause.kind as ConstructorClauseKind)
        || typeof clause.header !== "string" || !Array.isArray(clause.items) || clause.items.length === 0) invalid();
      for (const [index, item] of clause.items.entries()) {
        if (++entries > 65_536 || !isRecord(item) || item.index !== index || !isByteRange(item.range, raw.bytes)
          || item.range.start < statement.range.start || item.range.end > statement.range.end || typeof item.preview !== "string"
          || !(item.expression === null || (typeof item.expression === "string" && Buffer.byteLength(item.expression) <= limits.maxExpression))
          || !unsigned(item.comments) || typeof item.removable !== "boolean" || typeof item.movable !== "boolean"
          || !isRecord(item.unavailable) || ![item.unavailable.replace, item.unavailable.remove, item.unavailable.move].every(reason)) invalid();
      }
    }
  }
  return raw as unknown as ConstructorModel;
}

/** A portable SDK owns only a connection-bound token and ESKA's checked DTO, without an IDE or a second parser. */
export class QueryConstructor {
  private closed = false;
  private constructor(private readonly transport: Transport, private current: ConstructorModel, readonly original: string, readonly limits: ConstructorLimits) {}

  /** Capture allocation IDs before validating a response, so malformed data cannot strand the canonical draft lock. */
  static async capture(transport: Transport, raw: unknown, original: string, limits: ConstructorLimits): Promise<QueryConstructor> {
    const id = isRecord(raw) && isToken(raw.id) && raw.id !== "0" ? raw.id : undefined;
    try {
      const model = constructorModel(raw, limits);
      if (model.text !== original) invalid();
      return new QueryConstructor(transport, model, original, limits);
    } catch (error) {
      if (id) await transport("query/constructorCancel", { constructorId: id }).catch(() => {});
      throw error;
    }
  }

  /** Read-only presentation cannot become an alternative canonical text store. */
  get model(): Readonly<ConstructorModel> { return this.current; }

  /** Disposing a native panel after a successful finish must not cancel a later constructor. */
  get isClosed(): boolean { return this.closed; }

  /** Stale indices are rejected by ESKA, including parallel actions captured before the previous reply. */
  async action(action: ConstructorAction): Promise<void> {
    const result = await this.request("query/constructorAction", { action });
    if (!isRecord(result) || result.constructorActive !== true) invalid();
    this.current = constructorModel(result.constructor, this.limits, this.current.id);
  }

  /** Plan precedes the IDE's undoable text transaction and retains the canonical draft lock. */
  async plan(nativeSnapshot: string): Promise<QueryTextPlan> {
    const result = await this.request("query/constructorPlan", { nativeSnapshot });
    if (!isRecord(result) || result.constructorActive !== true) invalid();
    const plan = parseDraftPlan(result.draftPlan, this.original, querySnapshot(this.original), { maxMappings: 64, maxSnapshotBytes: 8_388_608 });
    if (plan.outputSnapshot !== this.current.snapshot) invalid();
    return plan;
  }

  /** Explicit finish publishes only the existing private draft; native source application remains a separate operation. */
  async finish(nativeSnapshot: string, resultSnapshot?: string): Promise<QueryTextPlan> {
    const result = await this.request("query/constructorFinish", { nativeSnapshot, ...(resultSnapshot ? { resultSnapshot } : {}) });
    this.closed = true;
    if (!isRecord(result) || result.constructorActive !== false || result.constructor !== null) invalid();
    const plan = parseDraftPlan(result.draftPlan, this.original, querySnapshot(this.original), { maxMappings: 64, maxSnapshotBytes: 8_388_608 });
    if (plan.outputSnapshot !== this.current.snapshot) invalid();
    return plan;
  }

  /** Cancellation discards only private working changes; it never restores or rewrites a source file. */
  async cancel(): Promise<void> {
    if (this.closed) return;
    const value = await this.transport("query/constructorCancel", { constructorId: this.current.id });
    if (!isRecord(value) || typeof value.released !== "boolean" || value.constructorActive !== false) invalid();
    this.closed = true;
  }

  /** The source-bound transport supplies the source session and metadata identity rather than accepting one from the UI. */
  private async request(method: ConstructorMethod, params: Record<string, unknown>): Promise<unknown> {
    if (this.closed) throw new ExplorerError("obsolete");
    return this.transport(method, { constructorId: this.current.id, constructorRevision: this.current.revision, ...params });
  }
}

/** Unknown future reason identifiers remain readable but cannot grant an operation permission. */
function reason(value: unknown): boolean { return value === null || (typeof value === "string" && value.length > 0 && value.length <= 128); }
