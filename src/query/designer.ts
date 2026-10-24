import * as vscode from "vscode";
import { randomBytes } from "node:crypto";
import { ExplorerError, isRecord } from "../protocol.js";
import { message, type MessageKey } from "../messages.js";
import type { CatalogPage, CatalogField, CatalogParameter, ConstructorSource, ConstructorAction } from "./constructors.js";
import type { NativeQueryConstructor } from "./native-constructor.js";
import { QUERY_SCHEME, type QueryTabs } from "./tabs.js";

interface View {
  panel: vscode.WebviewPanel; binding: NativeQueryConstructor; busy: boolean; ending: boolean; failedApply: boolean;
  statement: number; catalog?: CatalogPage; search?: string; browsed: Map<string, CatalogPage>;
  catalogKey?: string; fieldsKey?: string; fields?: (ConstructorSource & { fields: CatalogField[]; signature?: CatalogParameter[]; found: boolean; loaded: boolean })[]; metadataFailed?: boolean;
  resultKey?: string; resultFields?: CatalogField[];
}

/** The visual adapter renders ESKA's model and sends intentions; it contains no query parser or generator. */
export class QueryDesigner implements vscode.Disposable {
  private readonly views = new Map<string, View>();
  private readonly openings = new Map<string, Promise<void>>();
  private disposed = false;
  private readonly changes: vscode.Disposable;

  constructor(private readonly context: vscode.ExtensionContext, private readonly tabs: QueryTabs, private readonly log: (text: string) => void) {
    this.changes = tabs.onDidChangeLanguage(uri => {
      for (const [key, view] of this.views) if (!view.ending && (!uri || uri.toString() === key)) {
        void this.publish(view).catch(error => this.log(`constructor_state ${String(error)}`));
      }
    });
  }

  /** One visual panel owns one private draft; repeated commands only reveal its existing panel. */
  async show(uri = vscode.window.activeTextEditor?.document.uri): Promise<void> {
    if (!uri || uri.scheme !== QUERY_SCHEME || !uri.path.endsWith(".sdbl") || this.disposed) return;
    const existing = this.views.get(uri.toString()); if (existing) { existing.panel.reveal(); return; }
    const key = uri.toString(), opening = this.openings.get(key); if (opening) return opening;
    const pending = this.open(uri); this.openings.set(key, pending);
    try { await pending; } finally { if (this.openings.get(key) === pending) this.openings.delete(key); }
  }

  /** Concurrent toolbar commands share the same source allocation before any tab is replaced. */
  private async open(uri: vscode.Uri): Promise<void> {
    const document = await vscode.workspace.openTextDocument(uri), binding = await this.tabs.beginConstructor(document);
    if (this.disposed) { await binding.abandon(); return; }
    const roots = [vscode.Uri.joinPath(this.context.extensionUri, "resources", "query")];
    const panel = vscode.window.createWebviewPanel("eska.queryConstructor", this.text("constructorTitle"), vscode.ViewColumn.Active,
      { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: roots });
    const view: View = { panel, binding, busy: false, ending: false, failedApply: false, statement: 0, browsed: new Map() }; this.views.set(uri.toString(), view);
    binding.onReveal(() => { if (!view.ending && !this.disposed) panel.reveal(); });
    panel.webview.html = this.html(panel.webview);
    panel.webview.onDidReceiveMessage(value => { void this.receive(view, value).catch(error => this.failure(view, error)); });
    panel.onDidDispose(() => {
      this.views.delete(uri.toString());
      if (!view.ending) void binding.cancel().catch(error => this.log(`constructor_close ${String(error)}`));
    });
  }

  /** Messages can select only the binding already captured by this panel, never a source/session path. */
  private async receive(view: View, value: unknown): Promise<void> {
    if (this.disposed || view.ending || !isRecord(value)) return;
    if (view.busy) return;
    if (value.type === "cancel") {
      view.ending = true; try { await view.binding.cancel(); } finally { view.panel.dispose(); } return;
    }
    if (!view.binding.current || view.failedApply) throw new ExplorerError("sourceChanged");
    view.busy = true; await this.publish(view);
    try {
      if (value.type === "ready") {
        if (view.binding.core.limits.visual) {
          try { view.catalog = await view.binding.core.catalog(this.virtualCatalog(view)); await this.refreshFields(view); }
          catch { view.metadataFailed = true; }
        }
      } else if (value.type === "select" && Number.isSafeInteger(value.statement) && typeof value.statement === "number"
        && value.statement >= 0 && value.statement < view.binding.core.model.statements.length) {
        view.statement = value.statement; await this.refreshFields(view);
      } else if (value.type === "fields" && view.binding.core.limits.visual) {
        const source = view.fields?.find(source => source.table === value.table && source.alias === value.alias && (value.item === undefined || source.item === value.item && source.clause === value.clause));
        if (source && !source.loaded) {
          const data = await this.sourceCatalog(view, source);
          source.fields = data.fields; source.signature = data.parameters ?? []; source.found = data.found; source.loaded = true;
        }
      } else if (value.type === "catalog" && view.binding.core.limits.visual) {
        const query = { ...this.virtualCatalog(view), ...(typeof value.search === "string" ? { search: value.search } : {}),
          ...(typeof value.table === "string" ? { table: value.table } : {}),
          ...(typeof value.offset === "number" && Number.isSafeInteger(value.offset) && value.offset >= 0 ? { offset: value.offset } : {}) };
        const page = await view.binding.core.catalog(query); delete view.metadataFailed;
        if (query.table !== undefined) {
          view.browsed.set(query.table, page);
          if (view.browsed.size > 64) view.browsed.delete(view.browsed.keys().next().value!);
        } else {
          const tables = query.offset && view.search === query.search ? [...view.catalog?.tables ?? [], ...page.tables] : page.tables;
          view.catalog = { ...page, tables };
          if (query.search !== undefined) view.search = query.search; else delete view.search;
          await this.refreshFields(view);
        }
      } else if (value.type === "apply") {
        try { await view.binding.finish(); }
        catch (error) { view.failedApply = true; throw error; }
        view.ending = true; view.panel.dispose();
      } else if (value.type === "action" && isRecord(value.action)) {
        const action = value.action as unknown as ConstructorAction;
        try { await view.binding.core.action(action); this.followStructuralFocus(view, action); await this.refreshFields(view); }
        catch (error) {
          if (!["remove", "removeUnion", "removeStatement", "removeTotals", "setDcs", "setInto"].includes(action.kind) || !(error instanceof ExplorerError) || error.details?.reason !== "constructor_comments_require_decision") throw error;
          const decision = await this.commentDecision();
          if (decision && (action.kind === "remove" || action.kind === "removeUnion" || action.kind === "removeStatement" || action.kind === "removeTotals" || action.kind === "setDcs" || action.kind === "setInto")) { await view.binding.core.action({ ...action, comments: decision }); this.followStructuralFocus(view, action); await this.refreshFields(view); }
        }
      }
    } finally { view.busy = false; if (!view.ending) await this.publish(view); }
  }

  /** ESKA remaps the active scope after adding/removing a branch; adapters do not infer survivors from shifted indices. */
  private followStructuralFocus(view: View, action: ConstructorAction): void {
    if ((["addUnion", "removeUnion", "addStatement", "removeStatement", "moveStatement"].includes(action.kind)) && view.binding.core.model.focus !== undefined && view.binding.core.model.focus !== null) view.statement = view.binding.core.model.focus;
  }

  /** Bound field expressions come from ESKA; this view retains only the selected page's presentation data. */
  private async refreshFields(view: View): Promise<void> {
    if (!view.binding.core.limits.visual) return;
    view.statement = Math.min(view.statement, Math.max(0, view.binding.core.model.statements.length - 1));
    const model = view.binding.core.model, statement = model.statements[view.statement];
    if (view.binding.core.limits.packages && view.catalogKey !== `${view.statement}:${model.revision}`) {
      view.catalog = await view.binding.core.catalog({ ...this.virtualCatalog(view), ...(view.search ? { search: view.search } : {}) });
      view.catalogKey = `${view.statement}:${model.revision}`; view.browsed.clear();
    }
    const sources = statement?.sources ?? [], key = JSON.stringify([view.statement, sources, view.binding.core.limits.packages || sources.some(source => source.derived) ? model.revision : ""]);
    if (view.binding.core.limits.totals && statement?.scope !== undefined) {
      const resultKey = `${statement.scope}:${model.revision}`;
      if (view.resultKey !== resultKey) {
        try { const page = await view.binding.core.catalog({ scope: statement.scope }); view.resultFields = page.fields; view.resultKey = resultKey; }
        catch { view.resultFields = []; delete view.resultKey; view.metadataFailed = true; }
      }
    }
    if (view.fieldsKey === key) return;
    const fields: NonNullable<View["fields"]> = [];
    try {
      for (const source of sources) {
        const retained = !view.binding.core.limits.packages && !source.derived && view.fields?.find(value => value.table === source.table && value.alias === source.alias && JSON.stringify(value.parameters) === JSON.stringify(source.parameters) && value.loaded);
        if (retained) { fields.push({ ...retained, ...source }); continue; }
        if (fields.length >= 4) { fields.push({ ...source, fields: [], found: true, loaded: false }); continue; }
        const page = await this.sourceCatalog(view, source);
        fields.push({ ...source, fields: page.fields, signature: page.parameters ?? [], found: page.found, loaded: true });
      }
    } catch { view.fields = fields; view.metadataFailed = true; delete view.fieldsKey; return; }
    view.fields = fields; view.fieldsKey = key;
  }

  /** Bound selectors also resolve derived projections; physical fallback is limited to older negotiated backends. */
  private sourceCatalog(view: View, source: ConstructorSource): Promise<CatalogPage> {
    const query = this.virtualCatalog(view);
    if (view.binding.core.limits.nestedQueries) delete query.atStatement;
    return view.binding.core.catalog({ ...query, qualifier: source.alias, ...(view.binding.core.limits.nestedQueries && source.clause !== undefined && source.item !== undefined
      ? { source: { statement: view.statement, clause: source.clause, item: source.item } } : { table: source.table }) });
  }

  /** Older servers reject unknown request keys, including a new flag set to false. */
  private virtualCatalog(view: View): { virtualTables?: true; atStatement?: number } { return { ...(view.binding.core.limits.virtualTables ? { virtualTables: true as const } : {}), ...(view.binding.core.limits.packages ? { atStatement: view.statement } : {}) }; }

  /** The core requests an explicit choice before deleting a commented node. */
  private async commentDecision(): Promise<"keep" | "discard" | undefined> {
    const keep = this.text("constructorKeepComments"), discard = this.text("constructorDiscardComments");
    const choice = await vscode.window.showQuickPick([keep, discard], { placeHolder: this.text("constructorCommentDecision"), ignoreFocusOut: true });
    return choice === keep ? "keep" : choice === discard ? "discard" : undefined;
  }

  /** Availability explanations are presentation; all eligibility comes from the core DTO. */
  private async publish(view: View): Promise<void> {
    const labels: Record<string, string> = {};
    for (const [name, key] of Object.entries({ apply: "constructorApply", cancel: "constructorCancel", add: "constructorAdd", edit: "constructorEdit",
      remove: "constructorRemove", up: "constructorUp", down: "constructorDown", text: "constructorText", expression: "constructorExpression", submit: "constructorSubmit",
      close: "constructorCloseInput", fields: "constructorFields", sources: "constructorSources", joins: "constructorJoins", conditions: "constructorConditions", group: "constructorGroup", order: "constructorOrder",
      statement: "constructorStatement", notice: "constructorNotice", empty: "constructorEmpty", inner: "constructorInner", left: "constructorLeft", right: "constructorRight", full: "constructorFull" })) {
      labels[name] = this.text(key as MessageKey);
    }
    for (const name of ["tablesFields", "database", "tables", "selectedFields", "search", "find", "more", "allFields", "noTables", "noFields", "metadataUnavailable", "metadataFailed", "alias", "aggregate", "noAggregate", "sum", "count", "minimum", "maximum", "average", "leftField", "rightField", "rightValue", "comparison", "ascending", "descending", "direction", "rawExpression", "visualEditor", "groupFields", "aggregateFields", "noRows", "comparisonLike", "comparisonIn", "comparisonInHierarchy", "limitedContext", "categoryCatalog", "categoryDocument", "categoryEnum", "categoryInformationRegister", "categoryAccumulationRegister", "categoryAccountingRegister", "categoryCalculationRegister", "categoryChartOfAccounts", "categoryChartOfCharacteristicTypes", "categoryChartOfCalculationTypes", "categoryExchangePlan", "categoryBusinessProcess", "categoryTask", "categoryDocumentJournal"] as const) {
      labels[name] = this.text(`constructor${name[0]!.toUpperCase()}${name.slice(1)}` as MessageKey);
    }
    for (const name of ["unions", "totals", "totalGroups", "overall", "autoTotals", "nested", "editNested", "backParent", "branch", "unionAll", "unionDistinct", "addUnion", "unionMismatch", "parameters", "noParameters", "hierarchy", "onlyHierarchy", "noHierarchy", "periods", "noPeriods", "periodBegin", "periodEnd", "second", "minute", "hour", "day", "week", "tenDays", "month", "quarter", "halfYear", "year", "parameterPeriod", "parameterBeginPeriod", "parameterEndPeriod", "parameterPeriodicity", "parameterComplementMethod", "parameterCondition", "parameterAccountCondition", "parameterExtraDimensions", "parameterCorrespondingAccountCondition", "parameterCorrespondingExtraDimensions", "parameterDebitAccountCondition", "parameterDebitExtraDimensions", "parameterCreditAccountCondition", "parameterCreditExtraDimensions", "parameterOrder", "parameterTop", "parameterMainDimensions", "parameterBaseDimensions", "parameterSlices"] as const) {
      labels[name] = this.text(`constructor${name[0]!.toUpperCase()}${name.slice(1)}` as MessageKey);
    }
    for (const name of ["dcs", "dcsSelect", "dcsWhere", "dcsOptionalSource", "dcsParameter", "dcsVirtualFilter", "dcsOpaque", "dcsChildren", "dcsEnabled", "dcsNotice", "totalSection", "addTotalSection", "having", "packages", "temporaryTable", "destination", "setDestination", "addStatement", "destroyTable", "packageIssue", "index", "categoryTemporaryTable"] as const) {
      labels[name] = this.text(`constructor${name[0]!.toUpperCase()}${name.slice(1)}` as MessageKey);
    }
    const reasons = Object.fromEntries(["unsupported_statement", "unsupported_construct", "invalid_syntax", "model_limit", "read_only", "required_item", "source_required",
      "join_order_dependency", "single_item", "expression_too_large", "unsupported"].map(reason => [reason, this.reason(reason)]));
    reasons.union_field_count = this.text("constructorUnionMismatch");
    await view.panel.webview.postMessage({ type: "model", model: view.binding.core.model, labels, reasons, maxExpression: view.binding.core.limits.maxExpression,
      visual: view.binding.core.limits.visual === true, features: view.binding.core.limits, statement: view.statement,
      metadata: { catalog: view.catalog, details: [...view.browsed], fields: view.fields ?? [], resultFields: view.resultFields ?? [], failed: view.metadataFailed === true },
      busy: view.busy, paused: !view.binding.current || view.failedApply, pausedText: this.text(view.failedApply ? "constructorReceiptFailed" : "constructorChanged") });
  }

  /** Technical reasons stay in diagnostics; query text is never put into an executable error payload. */
  private async failure(view: View, error: unknown): Promise<void> {
    const reason = error instanceof ExplorerError ? String(error.details?.reason ?? "") : "";
    this.log(`constructor_error ${reason || (error instanceof ExplorerError ? error.code : "io")}`);
    const text = this.text(view.failedApply ? "constructorReceiptFailed" : error instanceof ExplorerError && error.code === "sourceChanged" ? "constructorChanged"
      : reason === "constructor_limit" ? "constructorLimit" : reason === "user_read_only" ? "queryReadonly" : "constructorInvalid");
    await view.panel.webview.postMessage({ type: "error", text });
  }

  /** A small local resource page receives all model text through postMessage and renders it with textContent. */
  private html(webview: vscode.Webview): string {
    const nonce = randomBytes(16).toString("hex"), root = vscode.Uri.joinPath(this.context.extensionUri, "resources", "query");
    const script = webview.asWebviewUri(vscode.Uri.joinPath(root, "designer.js")), style = webview.asWebviewUri(vscode.Uri.joinPath(root, "designer.css"));
    return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}'"><link rel="stylesheet" href="${style}"></head><body><main id="root"></main><script nonce="${nonce}" src="${script}"></script></body></html>`;
  }

  /** Unknown syntax and resource limits are distinct from normal read-only restrictions. */
  private reason(reason: string): string {
    const key: MessageKey = reason === "read_only" ? "queryReadonly" : ["model_limit", "expression_too_large"].includes(reason) ? "constructorLimit"
      : reason === "required_item" ? "constructorRequired" : reason === "source_required" ? "constructorSourceRequired" : reason === "single_item" ? "constructorSingle"
      : reason === "join_order_dependency" ? "constructorJoinOrder" : reason === "invalid_syntax" ? "constructorSyntax" : "constructorUnsupported";
    return this.text(key);
  }

  /** One translation function keeps all new UI strings present in both supported locales. */
  private text(key: MessageKey): string { return message(vscode.env.language, key); }

  /** Await owned tokens before metadata teardown, without opening an editor during window shutdown. */
  async shutdown(): Promise<void> {
    this.disposed = true;
    this.changes.dispose();
    await Promise.allSettled(this.openings.values());
    await Promise.allSettled([...this.views.values()].map(async view => { view.ending = true; await view.binding.abandon(); view.panel.dispose(); }));
    this.views.clear();
  }

  /** The extension's awaited shutdown owns asynchronous cleanup. */
  dispose(): void { void this.shutdown(); }
}
