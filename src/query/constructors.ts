import { ExplorerError, isRecord, isToken } from "../protocol.js";
import { querySnapshot } from "./client.js";
import { invalid, isByteRange, isSnapshot, unsigned, type ByteRange } from "./protocol.js";
import { parseDraftPlan, type QueryTextPlan } from "./plan.js";

export const BASE_CLAUSES = ["fields", "sources", "joins", "conditions", "group", "order"] as const;
export const CLAUSES = [...BASE_CLAUSES, "totals", "totalGroups"] as const;
export const PACKAGE_CLAUSES = [...CLAUSES, "into", "destroy", "index"] as const;
export const HAVING_CLAUSES = [...PACKAGE_CLAUSES, "having"] as const;
export type ConstructorClauseKind = typeof HAVING_CLAUSES[number];
export type ConstructorMethod = "query/constructorOpen" | "query/constructorPlan" | "query/constructorModel" | "query/constructorAction" | "query/constructorFinish" | "query/constructorCancel" | "query/constructorCatalog" | "query/constructorPreview";
export interface ConstructorLimits { maxExpression: number; maxModel: number; visual?: boolean; virtualTables?: boolean; nestedQueries?: boolean; unions?: boolean; totals?: boolean; packages?: boolean; having?: boolean; totalSections?: boolean; maxTotalSections?: number; dcs?: boolean; bulkItems?: boolean; maxBulkItems?: number; addSourceFields?: boolean; predicates?: boolean; unionMatrix?:boolean; actionPreview?:boolean; packageTree?:boolean; copyStatement?:boolean; modifiers?:boolean;maxTop?:number;maxLockSources?:number }
export interface ConstructorSelection { statement: number; clause: number; item: number }
export type Comparison = "equal" | "notEqual" | "less" | "lessOrEqual" | "greater" | "greaterOrEqual" | "like" | "in" | "inHierarchy";
export type Aggregate = "sum" | "count" | "minimum" | "maximum" | "average" | null;
export type PeriodUnit = "second" | "minute" | "hour" | "day" | "week" | "tenDays" | "month" | "quarter" | "halfYear" | "year";
export type Hierarchy = "none" | "hierarchy" | "onlyHierarchy";
export interface PeriodRange { unit: PeriodUnit; begin: string | null; end: string | null }
export type VisualExpression = { kind: "source"; table: string; alias: string }
  | { kind: "virtualSource"; table: string; alias: string; parameters: string[] }
  | { kind: "subquerySource"; alias: string }
  | { kind: "field" | "totalField"; expression: string; alias: string; aggregate: Aggregate }
  | { kind: "join"; table: string; alias: string; join: "inner" | "left" | "right" | "full"; left: string; comparison: Comparison; right: string }
  | { kind: "virtualJoin"; table: string; alias: string; parameters: string[]; join: "inner" | "left" | "right" | "full"; left: string; comparison: Comparison; right: string }
  | { kind: "subqueryJoin"; alias: string; join: "inner" | "left" | "right" | "full"; left: string; comparison: Comparison; right: string }
  | { kind: "condition" | "having"; left: string; comparison: Comparison; right: string }
  | { kind: "group"; expression: string } | { kind: "order"; expression: string; descending: boolean }
  | { kind: "totalGroup"; expression: string; alias: string; hierarchy: Hierarchy; period: PeriodRange | null } | { kind: "overall" };
export interface CatalogParameter { key: string; required: boolean; choices?: CatalogField[] }
export interface CatalogTable { name: string; category: string; russian: string; english: string; alias: string; virtualTable?: string }
export interface CatalogField { russian: string; english: string }
export interface CatalogPage { tables: CatalogTable[]; fields: CatalogField[]; parameters?: CatalogParameter[]; temporaryTables?: { name: string; scope: number; statement: number }[]; nextOffset: number | null; found: boolean; limitedContext: boolean; contextFingerprint: string }
export interface CatalogQuery { search?: string; offset?: number; limit?: number; table?: string; qualifier?: string; virtualTables?: boolean; source?: ConstructorSelection; scope?: number; atStatement?: number }
export type Predicate = {kind:'all'|'any';children:Predicate[]}|{kind:'not';child:Predicate}|{kind:'compare';left:string;comparison:Comparison;right:string}|{kind:'between';expression:string;begin:string;end:string}|{kind:'isNull';expression:string;negated:boolean}|{kind:'raw';expression:string};
export interface Modifiers {distinct:boolean;allowed:boolean;top:number|null;autoOrder:boolean;forUpdate:string[]|null}
export interface ModifierView {value:Modifiers;editable:boolean;autoOrderAvailable:boolean;forUpdateAvailable:boolean;sources:string[]}
export type ConstructorAction = {kind:'setModifiers';statement:number;modifiers:Modifiers}
  | {kind:'copyStatement';statement:number}
  | {kind:'alignUnion';statement:number}
  | {kind:'setJoinKind';selection:ConstructorSelection;join:'inner'|'left'|'right'|'full'}
  | {kind:'setPredicate';statement:number;clause:'conditions'|'having'|'joins';selection:ConstructorSelection|null;predicate:Predicate}
  | {kind:'movePredicate';selection:ConstructorSelection;target:'conditions'|'having'}
  | { kind: "compose"; statement: number; selection: ConstructorSelection | null; expression: VisualExpression }
  | { kind: "editItems"; statement: number; clause: number; items: number[]; operation: { kind: "remove" } | { kind: "move" | "copy"; to: number }; comments?: "keep" | "discard" }
  | { kind: "addSourceFields"; statement: number; source: VisualExpression; fields: string[] }
  | { kind: "setDcs"; statement: number; node: number | null; target: DcsKind; values: DcsValue[]; enabled: boolean; comments?: "keep" | "discard" }
  | { kind: "composeTotal"; statement: number; section: number; selection: ConstructorSelection | null; expression: VisualExpression }
  | { kind: "appendTotal"; statement: number; section: number; clause: "totals" | "totalGroups"; text: string }
  | { kind: "addTotals"; statement: number; after: number | null }
  | { kind: "removeTotals"; statement: number; section: number; comments?: "keep" | "discard" }
  | { kind: "moveTotals"; statement: number; section: number; to: number }
  | { kind: "appendFields"; statement: number; fields: string[] }
  | { kind: "append"; statement: number; clause: ConstructorClauseKind; text: string; join?: "inner" | "left" | "right" | "full" }
  | { kind: "replace"; selection: ConstructorSelection; text: string }
  | { kind: "remove"; selection: ConstructorSelection; comments?: "keep" | "discard" }
  | { kind: "move"; selection: ConstructorSelection; to: number }
  | { kind: "setInto"; statement: number; name: string | null; comments?: "keep" | "discard" }
  | { kind: "addStatement"; statement: number; operation: "select" | "destroy"; name: string | null }
  | { kind: "removeStatement"; statement: number; comments?: "keep" | "discard" }
  | { kind: "moveStatement"; statement: number; to: number }
  | { kind: "addUnion" | "setUnion"; statement: number; all: boolean } | { kind: "removeUnion"; statement: number; comments?: "keep" | "discard" };
export interface ConstructorItem {
  index: number; range: ByteRange; preview: string; expression: string | null; comments: number; removable: boolean; movable: boolean;
  unavailable: { replace: string | null; remove: string | null; move: string | null; copy?: string | null };
  visual?: VisualExpression | null;
  children?: number[]; moveUp?: boolean; moveDown?: boolean;
}
export interface ConstructorClause { index: number; kind: ConstructorClauseKind; header: string; items: ConstructorItem[]; predicate?:Predicate|null;join?:{kind:'inner'|'left'|'right'|'full';left:string[];right:string}|null }
export interface ConstructorStatement {
  index: number; range: ByteRange; unavailable: string | null; preview: string; clauses: ConstructorClause[];
  append: { kind: ConstructorClauseKind; unavailable: string | null }[];
  russian?: boolean; sources?: ConstructorSource[];
  scope?: number; branch?: number; nested?: boolean; result?: boolean; columns?: string[];
  package?: PackageControls;
  unionMatrix?:UnionMatrix|null;
  path?:number[];
  modifiers?:ModifierView|null;
  totalSections?: ConstructorTotalSection[]; addTotals?: boolean;
  dcs?: { russian: boolean; addSelect: boolean; addWhere: boolean; nodes: DcsNode[] };
}
export type DcsKind = "select" | "where" | "parameter" | "virtualFilter" | "optionalSource" | "opaque";
export type DcsValue = { kind: "field"; expression: string; children: boolean; alias: string }
  | { kind: "condition"; left: string; comparison: Comparison; right: string } | { kind: "parameter"; name: string };
export interface DcsNode { preview: string; index: number; kind: DcsKind; range: ByteRange; values: DcsValue[]; enabled: boolean; editable: boolean; comments: number }
export interface ConstructorTotalSection { index: number; fields: number; groups: number; range: ByteRange; remove: boolean; moveUp: number | null; moveDown: number | null }
export interface PackageControls { operation: "select" | "destroy" | null; position: number | null; first: number; destination: string | null; add: boolean; remove: boolean; setInto: boolean; moveUp: number | null; moveDown: number | null; copy?:boolean }
export interface ConstructorSource { table: string; alias: string; clause?: number; item?: number; derived?: boolean; nestedScope?: number | null; parameters?: string[]; temporaryDefinition?:number|null }
export interface UnionMatrix {scope:number;branches:number[];columns:{index:number;alias:string|null;cells:(ConstructorSelection|null)[]}[];canAlign:boolean}
export interface ConstructorScope { index: number; range: ByteRange; parent: number | null; branches: number[]; result: number; unions: { all: boolean }[] }
export interface ConstructorModel {
  id: string; revision: string; snapshot: string; text: string; bytes: number; writable: boolean; statements: ConstructorStatement[];
  scopes?: ConstructorScope[]; issues?: { code: string; scope: number; table?: string; column?: string | null }[];
  focus?: number | null;
  totalFocus?: number | null;
  itemFocus?: ConstructorSelection[];
}
type Transport = (method: ConstructorMethod, params: Record<string, unknown>) => Promise<unknown>;

/** An older backend cannot opt into a constructor by version alone or an incomplete writable capability. */
export function constructorCapabilities(hello: unknown): ConstructorLimits | undefined {
  if (!isRecord(hello) || !isRecord(hello.capabilities) || hello.capabilities.queryConstructor === undefined) return undefined;
  const value = hello.capabilities.queryConstructor;
  if (!isRecord(hello.apiVersion) || hello.apiVersion.major !== 1 || !unsigned(hello.apiVersion.minor) || hello.apiVersion.minor < 21
    || !isRecord(value) || value.schemaVersion !== 1 || value.writesOwner !== false || value.writesDraft !== true
    || value.explicitFinish !== true || value.exclusiveDraft !== true || value.lossless !== true || value.nativeDraftPlan !== true || value.sourceCommentPositions !== true
    || value.sharedQueryBudget !== true || !Array.isArray(value.clauses)
    || !unsigned(value.maxExpressionBytes) || value.maxExpressionBytes === 0
    || !unsigned(value.maxModelBytes) || value.maxModelBytes === 0) invalid();
  const advanced = ["virtualTables", "nestedQueries", "unions", "totals"] as const;
  const flags: Partial<ConstructorLimits> = {};
  for (const key of advanced) if (value[key] !== undefined) {
    if (hello.apiVersion.minor < 23 || value[key] !== true) invalid();
    flags[key] = true;
  }
  if (value.packages !== undefined || value.temporaryTables !== undefined) {
    if (hello.apiVersion.minor < 26 || value.packages !== true || value.temporaryTables !== true || !advanced.every(key => flags[key])) invalid();
    flags.packages = true;
  }
  if (value.having !== undefined) {
    if (hello.apiVersion.minor < 27 || value.having !== true || !flags.packages) invalid();
    flags.having = true;
  }
  if (value.totalSections !== undefined) {
    if (hello.apiVersion.minor < 30 || value.totalSections !== true || value.maxTotalSections !== 1 || !flags.having || value.multipleTotals !== undefined) invalid();
    flags.totalSections = true;
    flags.maxTotalSections = 1;
  } else if (value.multipleTotals !== undefined) {
    if (hello.apiVersion.minor < 28 || value.multipleTotals !== true || value.maxTotalSections !== 32 || !flags.having) invalid();
    flags.totalSections = true;
    flags.maxTotalSections = 32;
  }
  if (value.dcs !== undefined) {
    if (hello.apiVersion.minor < 29 || value.dcs !== true || value.maxDcsValues !== 128 || !flags.totalSections) invalid();
    flags.dcs = true;
  }
  if (value.bulkItems !== undefined || value.addSourceFields !== undefined || value.maxBulkItems !== undefined) {
    if (hello.apiVersion.minor < 31 || value.bulkItems !== true || value.addSourceFields !== true
      || !unsigned(value.maxBulkItems) || value.maxBulkItems === 0 || value.maxBulkItems > 512) invalid();
    flags.bulkItems = true; flags.addSourceFields = true; flags.maxBulkItems = value.maxBulkItems;
  }
  if(value.predicates!==undefined) {if(hello.apiVersion.minor<32||value.predicates!==true)invalid();flags.predicates=true;}
  for(const key of ['unionMatrix','actionPreview','packageTree','copyStatement'] as const)if(value[key]!==undefined){if(hello.apiVersion.minor<32||value[key]!==true)invalid();flags[key]=true;}
  if(value.modifiers!==undefined){if(hello.apiVersion.minor<32||value.modifiers!==true||value.maxTop!==4294967295||value.maxLockSources!==64)invalid();flags.modifiers=true;flags.maxTop=value.maxTop;flags.maxLockSources=value.maxLockSources;}
  if(flags.packageTree&&!flags.packages||flags.copyStatement&&(!flags.packageTree||!flags.actionPreview)||flags.unionMatrix&&(!flags.unions||!flags.bulkItems||!flags.actionPreview)||flags.predicates&&!flags.having)invalid();
  const clauses = flags.having ? HAVING_CLAUSES : flags.packages ? PACKAGE_CLAUSES : flags.totals ? CLAUSES : BASE_CLAUSES;
  if (value.clauses.length !== clauses.length || !value.clauses.every((kind, index) => kind === clauses[index])) invalid();
  const visual = value.visualExpressions !== undefined || value.metadataCatalog !== undefined;
  if ((Object.keys(flags).length && !visual) || (visual && (hello.apiVersion.minor < 22 || value.visualExpressions !== true || value.metadataCatalog !== true))) invalid();
  return { maxExpression: Math.min(value.maxExpressionBytes, 16_384), maxModel: Math.min(value.maxModelBytes, 33_554_432), ...(visual ? { visual: true } : {}), ...flags };
}

/** Validate only transport shape and snapshot bytes; parsing, eligibility and text generation remain in ESKA. */
export function constructorModel(raw: unknown, limits: ConstructorLimits, id?: string): ConstructorModel {
  if (!isRecord(raw) || !isToken(raw.id) || raw.id === "0" || (id !== undefined && raw.id !== id)
    || !isToken(raw.revision) || raw.revision === "0" || !isSnapshot(raw.snapshot) || typeof raw.text !== "string"
    || !unsigned(raw.bytes) || raw.bytes > 8_388_608 || Buffer.byteLength(raw.text) !== raw.bytes || querySnapshot(raw.text) !== raw.snapshot
    || Buffer.from(raw.text).toString() !== raw.text || typeof raw.writable !== "boolean"
    || !Array.isArray(raw.statements) || raw.statements.length > 256 || Buffer.byteLength(JSON.stringify(raw)) > limits.maxModel) invalid();
  const statementCount=raw.statements.length;
  let entries = 0;
  const clauses = limits.having ? HAVING_CLAUSES : limits.packages ? PACKAGE_CLAUSES : limits.totals ? CLAUSES : BASE_CLAUSES;
  for (const [index, statement] of raw.statements.entries()) {
    if (!isRecord(statement) || statement.index !== index || !isByteRange(statement.range, raw.bytes)
      || !reason(statement.unavailable) || typeof statement.preview !== "string" || !Array.isArray(statement.clauses)
      || !Array.isArray(statement.append) || statement.append.length !== clauses.length) invalid();
    if (statement.russian !== undefined && (typeof statement.russian !== "boolean" || !Array.isArray(statement.sources)
      || statement.sources.length > 65_536 || !statement.sources.every(source => isRecord(source) && shortText(source.table) && shortText(source.alias)
        && (source.parameters === undefined || parameters(source.parameters))))) invalid();
    if (limits.packages) validatePackage(statement.package, raw.statements.length);
    if(limits.modifiers&&statement.modifiers!==null&&!modifierView(statement.modifiers))invalid();
    if(limits.packageTree&&Array.isArray(statement.sources)&&!statement.sources.every(source=>isRecord(source)&&(source.temporaryDefinition===null||unsigned(source.temporaryDefinition)&&source.temporaryDefinition<statementCount)))invalid();
    if(limits.packageTree&&(!Array.isArray(statement.path)||statement.path.length>33||!statement.path.every(index=>unsigned(index)&&index<statementCount)||statement.path.at(-1)!==statement.index))invalid();
    if(limits.copyStatement&&(!isRecord(statement.package)||typeof statement.package.copy!=='boolean'))invalid();
    if (limits.totalSections) validateTotals(statement, raw.bytes, limits.maxTotalSections ?? 0);
    if (limits.dcs) validateDcs(statement, raw.bytes);
    for (const [index, option] of statement.append.entries()) {
      if (!isRecord(option) || option.kind !== clauses[index] || !reason(option.unavailable)) invalid();
    }
    for (const [index, clause] of statement.clauses.entries()) {
      if (!isRecord(clause) || clause.index !== index || !(clauses as readonly unknown[]).includes(clause.kind)
        || typeof clause.header !== "string" || !Array.isArray(clause.items) || (clause.items.length === 0 && clause.kind !== "totals")) invalid();
      if(limits.predicates) {
        if(clause.predicate!==null&&!predicateValue(clause.predicate))invalid();
        if(clause.join!==null&&(!isRecord(clause.join)||!['inner','left','right','full'].includes(String(clause.join.kind))||!Array.isArray(clause.join.left)||!clause.join.left.every(shortText)||!shortText(clause.join.right)))invalid();
      }
      for (const [index, item] of clause.items.entries()) {
        if (++entries > 65_536 || !isRecord(item) || item.index !== index || !isByteRange(item.range, raw.bytes)
          || item.range.start < statement.range.start || item.range.end > statement.range.end || typeof item.preview !== "string"
          || !(item.expression === null || (typeof item.expression === "string" && Buffer.byteLength(item.expression) <= limits.maxExpression))
          || !unsigned(item.comments) || typeof item.removable !== "boolean" || typeof item.movable !== "boolean"
          || !isRecord(item.unavailable) || ![item.unavailable.replace, item.unavailable.remove, item.unavailable.move].every(reason)) invalid();
        if (item.visual !== undefined && item.visual !== null && !visualExpression(item.visual)) invalid();
        if (limits.bulkItems && !reason(item.unavailable.copy)) invalid();
        if (item.moveUp !== undefined && typeof item.moveUp !== "boolean" || item.moveDown !== undefined && typeof item.moveDown !== "boolean") invalid();
      }
    }
  }
  if ((limits.nestedQueries || limits.unions) && raw.scopes === undefined) invalid();
  if (limits.totalSections && !(raw.totalFocus === null || unsigned(raw.totalFocus) && raw.totalFocus < (limits.maxTotalSections ?? 0))) invalid();
  validateScopes(raw);
  const statements = raw.statements;
  if (limits.bulkItems && (!Array.isArray(raw.itemFocus) || raw.itemFocus.length > (limits.maxBulkItems ?? 0)
    || !raw.itemFocus.every(selection => isRecord(selection) && unsigned(selection.statement) && unsigned(selection.clause) && unsigned(selection.item)
      && !!statements[selection.statement]?.clauses[selection.clause]?.items[selection.item]))) invalid();
  if(limits.unionMatrix)for(const statement of statements){
    const matrix=statement.unionMatrix;
    if(matrix===null)continue;
    if(!isRecord(matrix)||!unsigned(matrix.scope)||!Array.isArray(matrix.branches)||matrix.branches.length>256||!matrix.branches.every(id=>unsigned(id)&&!!statements[id])||typeof matrix.canAlign!=='boolean'||!Array.isArray(matrix.columns)||matrix.columns.length>512)invalid();
    const branches=matrix.branches;
    for(const [index,column] of matrix.columns.entries())if(!isRecord(column)||column.index!==index||!(column.alias===null||shortText(column.alias))||!Array.isArray(column.cells)||column.cells.length!==matrix.branches.length||!column.cells.every((cell,branch)=>cell===null||isRecord(cell)&&unsigned(cell.statement)&&cell.statement===branches[branch]&&unsigned(cell.clause)&&unsigned(cell.item)&&!!statements[cell.statement]?.clauses[cell.clause]?.items[cell.item]))invalid();
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
  async catalog(query: CatalogQuery): Promise<CatalogPage> {
    if (!this.limits.visual) throw new ExplorerError("incompatible");
    if (query.atStatement !== undefined && !this.limits.packages) throw new ExplorerError("incompatible");
    const result = await this.request("query/constructorCatalog", { query });
    if (!isRecord(result) || !isRecord(result.catalog)) invalid();
    const value = result.catalog;
    if (!Array.isArray(value.tables) || value.tables.length > 500 || !Array.isArray(value.fields) || value.fields.length > 65_536
      || !(value.nextOffset === null || unsigned(value.nextOffset)) || typeof value.found !== "boolean" || typeof value.limitedContext !== "boolean"
      || !isSnapshot(value.contextFingerprint) || !value.tables.every(table => isRecord(table) && [table.name, table.category, table.russian, table.english, table.alias].every(shortText) && (table.virtualTable === undefined || shortText(table.virtualTable)))
      || !value.fields.every(field => isRecord(field) && shortText(field.russian) && shortText(field.english))
      || value.parameters !== undefined && (!Array.isArray(value.parameters) || value.parameters.length > 16 || !value.parameters.every(parameter => isRecord(parameter)
        && shortText(parameter.key) && typeof parameter.required === "boolean" && (parameter.choices === undefined || Array.isArray(parameter.choices) && parameter.choices.length <= 32
          && parameter.choices.every(choice => isRecord(choice) && shortText(choice.russian) && shortText(choice.english)))))) invalid();
    if (value.temporaryTables !== undefined && (!this.limits.packages || !Array.isArray(value.temporaryTables) || value.temporaryTables.length > 256
      || !value.temporaryTables.every(table => isRecord(table) && shortText(table.name) && unsigned(table.scope) && unsigned(table.statement) && table.statement < this.current.statements.length))) invalid();
    return value as unknown as CatalogPage;
  }

  /** A preview is validated against the same snapshot and never replaces this acknowledged model. */
  async preview(action:ConstructorAction):Promise<ConstructorModel>{
    if(!this.limits.actionPreview)throw new ExplorerError('incompatible');
    this.requireAction(action);
    const revision=this.current.revision,result=await this.request('query/constructorPreview',{action});
    if(!isRecord(result)||result.baseRevision!==revision||this.current.revision!==revision)throw new ExplorerError('obsolete');
    return constructorModel(result.preview,this.limits,this.current.id);
  }

  /** Stale indices are rejected by ESKA, including parallel actions captured before the previous reply. */
  async action(action: ConstructorAction): Promise<void> {
    this.requireAction(action);
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

  /** Explicit capabilities govern the same intention in preview and publication. */
  private requireAction(action:ConstructorAction):void {
    if(action.kind==="setModifiers"&&!this.limits.modifiers)throw new ExplorerError("incompatible");
    if(action.kind==="copyStatement"&&!this.limits.copyStatement)throw new ExplorerError("incompatible");
    if(action.kind==="alignUnion"&&!this.limits.unionMatrix)throw new ExplorerError("incompatible");
    if (["setJoinKind","setPredicate","movePredicate"].includes(action.kind)&&!this.limits.predicates)throw new ExplorerError("incompatible");
    if (action.kind === "editItems" && !this.limits.bulkItems || action.kind === "addSourceFields" && !this.limits.addSourceFields) throw new ExplorerError("incompatible");
    if (action.kind === "setDcs" && !this.limits.dcs) throw new ExplorerError("incompatible");
    if (["setInto", "addStatement", "removeStatement", "moveStatement"].includes(action.kind) && !this.limits.packages) throw new ExplorerError("incompatible");
    if (["addTotals", "removeTotals", "moveTotals", "composeTotal", "appendTotal"].includes(action.kind) && !this.limits.totalSections) throw new ExplorerError("incompatible");
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
    case "virtualSource": return shortText(value.table) && shortText(value.alias) && parameters(value.parameters);
    case "subquerySource": return shortText(value.alias);
    case "field": case "totalField": return shortText(value.expression) && shortText(value.alias) && (value.aggregate === null || ["sum", "count", "minimum", "maximum", "average"].includes(String(value.aggregate)));
    case "condition": case "having": case "join": case "virtualJoin": case "subqueryJoin": return shortText(value.left) && shortText(value.right)
      && ["equal", "notEqual", "less", "lessOrEqual", "greater", "greaterOrEqual", "like", "in", "inHierarchy"].includes(String(value.comparison))
      && (["condition", "having"].includes(value.kind) || (shortText(value.alias) && ["inner", "left", "right", "full"].includes(String(value.join))
        && (value.kind === "subqueryJoin" || shortText(value.table)) && (value.kind !== "virtualJoin" || parameters(value.parameters))));
    case "group": return shortText(value.expression);
    case "order": return shortText(value.expression) && typeof value.descending === "boolean";
    case "overall": return true;
    case "totalGroup": return shortText(value.expression) && shortText(value.alias) && ["none", "hierarchy", "onlyHierarchy"].includes(String(value.hierarchy))
      && (value.period === null || isRecord(value.period) && ["second", "minute", "hour", "day", "week", "tenDays", "month", "quarter", "halfYear", "year"].includes(String(value.period.unit))
        && [value.period.begin, value.period.end].every(boundary => boundary === null || shortText(boundary)));
    default: return false;
  }
}

/** Arguments stay positional and bounded; this check deliberately knows nothing about query syntax. */
function parameters(value: unknown): boolean { return Array.isArray(value) && value.length <= 16 && value.every(shortText); }

/** Package controls are permissions and target ordinals supplied by ESKA, never inferred from statement text. */
function validatePackage(value: unknown, statements: number): void {
  if (!isRecord(value) || ![null, "select", "destroy"].includes(value.operation as string | null)
    || !(value.position === null || unsigned(value.position)) || !unsigned(value.first) || value.first >= statements
    || !(value.destination === null || shortText(value.destination)) || ![value.add, value.remove, value.setInto].every(v => typeof v === "boolean")
    || ![value.moveUp, value.moveDown].every(v => v === null || unsigned(v))) invalid();
}

/** The transport checks DTO shape and byte containment; DCS grammar, signatures and positions belong to ESKA. */
function validateDcs(owner: Record<string, unknown>, bytes: number): void {
  const value = owner.dcs;
  if (!isRecord(value) || typeof value.russian !== "boolean" || typeof value.addSelect !== "boolean" || typeof value.addWhere !== "boolean"
    || !Array.isArray(value.nodes) || value.nodes.length > 65_536 || !isByteRange(owner.range, bytes)) invalid();
  for (const [index, node] of value.nodes.entries()) {
    if (!isRecord(node) || node.index !== index || !["select", "where", "parameter", "virtualFilter", "optionalSource", "opaque"].includes(String(node.kind))
      || !isByteRange(node.range, bytes) || node.range.start < owner.range.start || node.range.end > owner.range.end
      || typeof node.preview !== "string" || typeof node.enabled !== "boolean" || typeof node.editable !== "boolean" || !unsigned(node.comments)
      || !Array.isArray(node.values) || node.values.length > 128 || !node.values.every(dcsValue)) invalid();
  }
}

/** DCS value controls contain data only and never transmit a renderer-generated fragment. */
function dcsValue(value: unknown): boolean {
  if (!isRecord(value)) return false;
  if (value.kind === "parameter") return shortText(value.name);
  if (value.kind === "field") return shortText(value.expression) && shortText(value.alias) && typeof value.children === "boolean";
  return value.kind === "condition" && visualExpression({ ...value, kind: "condition" });
}

/** The transport validates section-to-clause references; SQL pairing and edit permissions come exclusively from ESKA. */
function validateTotals(owner: Record<string, unknown>, bytes: number, maxSections: number): void {
  if (!Array.isArray(owner.totalSections) || owner.totalSections.length > maxSections || typeof owner.addTotals !== "boolean" || !Array.isArray(owner.clauses)) invalid();
  let previous = 0;
  const count = owner.totalSections.length;
  for (const [index, section] of owner.totalSections.entries()) {
    if (!isRecord(section) || section.index !== index || !unsigned(section.fields) || !unsigned(section.groups)
      || !isRecord(owner.clauses[section.fields]) || owner.clauses[section.fields].kind !== "totals"
      || !isRecord(owner.clauses[section.groups]) || owner.clauses[section.groups].kind !== "totalGroups"
      || !isByteRange(section.range, bytes) || section.range.start < previous || typeof section.remove !== "boolean"
      || ![section.moveUp, section.moveDown].every(to => to === null || unsigned(to) && to < count)) invalid();
    previous = section.range.end;
  }
}

/** Validate the backend's navigation graph without discovering scopes or source bindings in SQL text. */
function validateScopes(raw: Record<string, unknown>): void {
  if (raw.scopes === undefined) return;
  if (!Array.isArray(raw.scopes) || raw.scopes.length > 256 || !Array.isArray(raw.statements) || !unsigned(raw.bytes)) invalid();
  const scopes = raw.scopes, statements = raw.statements;
  if (raw.focus !== undefined && raw.focus !== null && (!unsigned(raw.focus) || raw.focus >= statements.length)) invalid();
  const statementIndex = (value: unknown): value is number => unsigned(value) && value < statements.length;
  const scopeIndex = (value: unknown): value is number => unsigned(value) && value < scopes.length;
  const members = new Set<number>();
  for (const [index, scope] of scopes.entries()) {
    if (!isRecord(scope) || scope.index !== index || !isByteRange(scope.range, raw.bytes) || !(scope.parent === null || statementIndex(scope.parent))
      || !Array.isArray(scope.branches) || !scope.branches.length || !scope.branches.every(statementIndex)
      || scope.result !== scope.branches.at(-1) || !Array.isArray(scope.unions) || scope.unions.length !== scope.branches.length - 1
      || !scope.unions.every(union => isRecord(union) && typeof union.all === "boolean")) invalid();
    for (const [branch, id] of scope.branches.entries()) {
      const statement = statements[id];
      if (members.has(id) || !isRecord(statement) || statement.scope !== index || statement.branch !== branch || statement.nested !== (scope.parent !== null)
        || statement.result !== (scope.result === id) || !isByteRange(statement.range, raw.bytes) || statement.range.start < scope.range.start || statement.range.end > scope.range.end
        || !Array.isArray(statement.columns) || !statement.columns.every(column => typeof column === "string" && Buffer.byteLength(column) <= 8_388_608)) invalid();
      members.add(id);
    }
    const seen = new Set<number>([index]);
    let parent = scope.parent;
    while (parent !== null) {
      const owner = statements[parent];
      if (!isRecord(owner) || !scopeIndex(owner.scope) || seen.has(owner.scope) || seen.size > 32) invalid();
      seen.add(owner.scope);
      const ancestor = scopes[owner.scope];
      if (!isRecord(ancestor) || !(ancestor.parent === null || statementIndex(ancestor.parent))) invalid();
      parent = ancestor.parent;
    }
  }
  if (members.size !== statements.length || !Array.isArray(raw.issues) || !raw.issues.every(issue => isRecord(issue) && shortText(issue.code) && scopeIndex(issue.scope))) invalid();
  for (const statement of statements) {
    if (!isRecord(statement) || !Array.isArray(statement.clauses) || !Array.isArray(statement.sources)) invalid();
    for (const source of statement.sources) if (!isRecord(source) || !unsigned(source.clause) || !unsigned(source.item) || typeof source.derived !== "boolean"
      || !(source.nestedScope === null || scopeIndex(source.nestedScope)) || !isRecord(statement.clauses[source.clause])
      || !Array.isArray(statement.clauses[source.clause].items) || source.item >= statement.clauses[source.clause].items.length) invalid();
    for (const clause of statement.clauses) {
      if (!isRecord(clause) || !Array.isArray(clause.items)) invalid();
      for (const item of clause.items) if (!isRecord(item) || !Array.isArray(item.children) || !item.children.every(scopeIndex)) invalid();
    }
  }
}

/** Bound the recursive DTO before the renderer can traverse it; this is shape validation, not a resolver. */
function predicateValue(value:unknown,depth=0,budget={nodes:0}):value is Predicate {
 if(++budget.nodes>512||depth>32||!isRecord(value))return false;
 if(value.kind==='all'||value.kind==='any')return Array.isArray(value.children)&&value.children.length>0&&value.children.every(child=>predicateValue(child,depth+1,budget));
 if(value.kind==='not')return predicateValue(value.child,depth+1,budget);
 if(value.kind==='compare')return visualExpression({kind:'condition',left:value.left,comparison:value.comparison,right:value.right});
 if(value.kind==='between')return [value.expression,value.begin,value.end].every(value=>typeof value==='string'&&Buffer.byteLength(value)<=16384);
 if(value.kind==='isNull')return typeof value.expression==='string'&&Buffer.byteLength(value.expression)<=16384&&typeof value.negated==='boolean';
 return value.kind==='raw'&&typeof value.expression==='string'&&Buffer.byteLength(value.expression)<=16384;
}

/** Settings are checked DTO values; source eligibility and keyword construction remain in ESKA. */
function modifierView(view:unknown):view is ModifierView {
 if(!isRecord(view)||!isRecord(view.value)||typeof view.editable!=='boolean'||typeof view.autoOrderAvailable!=='boolean'||typeof view.forUpdateAvailable!=='boolean'||!Array.isArray(view.sources)||view.sources.length>65536||!view.sources.every(shortText))return false;
 const value=view.value;return typeof value.distinct==='boolean'&&typeof value.allowed==='boolean'&&typeof value.autoOrder==='boolean'&&(value.top===null||unsigned(value.top)&&value.top<=4294967295)&&(value.forUpdate===null||Array.isArray(value.forUpdate)&&value.forUpdate.length<=64&&value.forUpdate.every(shortText));
}
