import { ExplorerError, isRecord, isToken } from "../protocol.js";
import { querySnapshot } from "./client.js";
import { invalid, isByteRange, isSnapshot, unsigned, type ByteRange } from "./protocol.js";
import { parseDraftPlan, type QueryTextPlan } from "./plan.js";

export const CLAUSES = ["fields", "sources", "joins", "conditions", "group", "order"] as const;
export type ConstructorClauseKind = typeof CLAUSES[number];
export type ConstructorMethod = "query/constructorOpen" | "query/constructorPlan" | "query/constructorModel" | "query/constructorAction" | "query/constructorFinish" | "query/constructorCancel" | "query/constructorCatalog";
export interface ConstructorLimits { maxExpression: number; maxModel: number; visual?: boolean }
export interface ConstructorSelection { statement: number; clause: number; item: number }
export type Comparison = "equal" | "notEqual" | "less" | "lessOrEqual" | "greater" | "greaterOrEqual" | "like" | "in" | "inHierarchy";
export type VisualExpression = { kind: "source"; table: string; alias: string }
  | { kind: "field"; expression: string; alias: string; aggregate: "sum" | "count" | "minimum" | "maximum" | "average" | null }
  | { kind: "join"; table: string; alias: string; join: "inner" | "left" | "right" | "full"; left: string; comparison: Comparison; right: string }
  | { kind: "condition"; left: string; comparison: Comparison; right: string }
  | { kind: "group"; expression: string } | { kind: "order"; expression: string; descending: boolean };
export interface CatalogTable { name: string; category: string; russian: string; english: string; alias: string }
export interface CatalogField { russian: string; english: string }
export interface CatalogPage { tables: CatalogTable[]; fields: CatalogField[]; nextOffset: number | null; found: boolean; limitedContext: boolean; contextFingerprint: string }
export type ConstructorAction = { kind: "compose"; statement: number; selection: ConstructorSelection | null; expression: VisualExpression }
  | { kind: "appendFields"; statement: number; fields: string[] }
  | { kind: "append"; statement: number; clause: ConstructorClauseKind; text: string; join?: "inner" | "left" | "right" | "full" }
  | { kind: "replace"; selection: ConstructorSelection; text: string }
  | { kind: "remove"; selection: ConstructorSelection; comments?: "keep" | "discard" }
  | { kind: "move"; selection: ConstructorSelection; to: number };
export interface ConstructorItem {
  index: number; range: ByteRange; preview: string; expression: string | null; comments: number; removable: boolean; movable: boolean;
  unavailable: { replace: string | null; remove: string | null; move: string | null };
  visual?: VisualExpression | null;
}
export interface ConstructorClause { index: number; kind: ConstructorClauseKind; header: string; items: ConstructorItem[] }
export interface ConstructorStatement {
  index: number; range: ByteRange; unavailable: string | null; preview: string; clauses: ConstructorClause[];
  append: { kind: ConstructorClauseKind; unavailable: string | null }[];
  russian?: boolean; sources?: { table: string; alias: string }[];
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
  const visual = value.visualExpressions !== undefined || value.metadataCatalog !== undefined;
  if (visual && (hello.apiVersion.minor < 22 || value.visualExpressions !== true || value.metadataCatalog !== true)) invalid();
  return { maxExpression: Math.min(value.maxExpressionBytes, 16_384), maxModel: Math.min(value.maxModelBytes, 33_554_432), ...(visual ? { visual: true } : {}) };
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
    if (statement.russian !== undefined && (typeof statement.russian !== "boolean" || !Array.isArray(statement.sources)
      || statement.sources.length > 65_536 || !statement.sources.every(source => isRecord(source) && shortText(source.table) && shortText(source.alias)))) invalid();
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
        if (item.visual !== undefined && item.visual !== null && !visualExpression(item.visual)) invalid();
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

  /** Read one bounded metadata page from the constructor's own application; no client parses XML or constructs field paths. */
  async catalog(query: { search?: string; offset?: number; limit?: number; table?: string; qualifier?: string }): Promise<CatalogPage> {
    if (!this.limits.visual) throw new ExplorerError("incompatible");
    const result = await this.request("query/constructorCatalog", { query });
    if (!isRecord(result) || !isRecord(result.catalog)) invalid();
    const value = result.catalog;
    if (!Array.isArray(value.tables) || value.tables.length > 500 || !Array.isArray(value.fields) || value.fields.length > 65_536
      || !(value.nextOffset === null || unsigned(value.nextOffset)) || typeof value.found !== "boolean" || typeof value.limitedContext !== "boolean"
      || !isSnapshot(value.contextFingerprint) || !value.tables.every(table => isRecord(table) && [table.name, table.category, table.russian, table.english, table.alias].every(shortText))
      || !value.fields.every(field => isRecord(field) && shortText(field.russian) && shortText(field.english))) invalid();
    return value as unknown as CatalogPage;
  }

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

/** Shape checks do not implement query syntax; ESKA remains the authority for every expression. */
function shortText(value: unknown): value is string { return typeof value === "string" && Buffer.byteLength(value) <= 16_384; }

/** Reject malformed structured DTOs before rendering native inputs; all domain eligibility remains in the backend. */
function visualExpression(value: unknown): boolean {
  if (!isRecord(value)) return false;
  switch (value.kind) {
    case "source": return shortText(value.table) && shortText(value.alias);
    case "field": return shortText(value.expression) && shortText(value.alias) && (value.aggregate === null || ["sum", "count", "minimum", "maximum", "average"].includes(String(value.aggregate)));
    case "condition": case "join": return shortText(value.left) && shortText(value.right)
      && ["equal", "notEqual", "less", "lessOrEqual", "greater", "greaterOrEqual", "like", "in", "inHierarchy"].includes(String(value.comparison))
      && (value.kind === "condition" || (shortText(value.table) && shortText(value.alias) && ["inner", "left", "right", "full"].includes(String(value.join))));
    case "group": return shortText(value.expression);
    case "order": return shortText(value.expression) && typeof value.descending === "boolean";
    default: return false;
  }
}
