import * as vscode from "vscode";
import type { LanguageClient, Diagnostic as LspDiagnostic, Hover as LspHover } from "vscode-languageclient/node";
import { isRecord } from "../protocol.js";
import { message, type MessageKey } from "../messages.js";
import { LanguageDocuments } from "../language/documents.js";
import { QUERY_SCHEME, type QueryTabs } from "./tabs.js";
import { isPosition, type QueryPosition } from "./protocol.js";
import type { QueryLanguageProjection, ProjectedEdit } from "./projections.js";

type WireRange = { start: QueryPosition; end: QueryPosition };
export interface QueryLanguageBinding {
  client: LanguageClient; documents: LanguageDocuments; limited: boolean; valid(): boolean; epoch(): number; indexing(): boolean; contains(path: string): boolean;
}
interface View {
  document: vscode.TextDocument; version: number; owner: vscode.TextDocument; nativeVersion: number;
  projection: QueryLanguageProjection; binding: QueryLanguageBinding; epoch: number; active: boolean; cancellation: vscode.CancellationTokenSource;
  released?: Promise<void>;
}

/** IDE providers bind ESKA projections to the window's existing LSP, without parsing BSL or SDBL. */
export class QueryLanguage implements vscode.Disposable {
  private binding: QueryLanguageBinding | undefined;
  private readonly views = new Map<vscode.TextDocument, View>();
  private readonly timers = new Map<vscode.TextDocument, NodeJS.Timeout>();
  private readonly tasks = new Map<vscode.TextDocument, Promise<View | undefined>>();
  private readonly states = new Map<vscode.TextDocument, MessageKey>();
  private readonly internal = new WeakSet<object>();
  private readonly diagnostics = vscode.languages.createDiagnosticCollection("eska-query");
  private readonly status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 2);
  private readonly subscriptions: vscode.Disposable[];
  private disposed = false;

  constructor(private readonly tabs: QueryTabs, private readonly log: (value: string) => void) {
    const selector = { scheme: QUERY_SCHEME, language: "sdbl" };
    this.subscriptions = [tabs.onDidChangeLanguage(uri => this.changed(uri)),
      vscode.workspace.onDidOpenTextDocument(document => { if (document.uri.scheme === QUERY_SCHEME) this.schedule(document); }),
      vscode.workspace.onDidCloseTextDocument(document => { void this.remove(document); this.states.delete(document); this.render(); }),
      vscode.workspace.onDidChangeTextDocument(event => {
        if (!event.contentChanges.length || event.document.uri.scheme !== "file") return;
        for (const view of this.views.values()) if (view.owner === event.document) this.schedule(view.document);
        if (this.binding?.documents.poisoned(event.document.uri.toString()) && !this.binding.documents.projected(event.document.uri.toString())) {
          void this.nativeDiagnostics(this.binding, event.document);
        }
      }), vscode.window.onDidChangeActiveTextEditor(() => this.render()),
      vscode.languages.registerCompletionItemProvider(selector, { provideCompletionItems: (doc, pos, token, context) => this.completion(doc, pos, token, context) }, ".", "&"),
      vscode.languages.registerHoverProvider(selector, { provideHover: (doc, pos, token) => this.hover(doc, pos, token) }),
      vscode.languages.registerDefinitionProvider(selector, { provideDefinition: (doc, pos, token) => this.locations(doc, pos, token, "textDocument/definition") }),
      vscode.languages.registerTypeDefinitionProvider(selector, { provideTypeDefinition: (doc, pos, token) => this.locations(doc, pos, token, "textDocument/typeDefinition") }),
      vscode.languages.registerReferenceProvider(selector, { provideReferences: (doc, pos, context, token) => this.locations(doc, pos, token, "textDocument/references", { context }) })];
  }

  /** Lifecycle changes invalidate requests immediately; rebuilding waits for the checked shared language client. */
  attach(binding: QueryLanguageBinding): void { this.binding = binding; this.changed(); }

  /** Teardown restores every native URI before the client releases its process and analyzer lease. */
  async detach(): Promise<void> {
    this.binding = undefined;
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    await Promise.allSettled([...this.views.keys()].map(document => this.remove(document)));
    await Promise.allSettled([...this.tasks.values()]);
    if (!this.disposed) this.diagnostics.clear(); this.changed();
  }

  /** Metadata, editor and progress changes cancel obsolete work and coalesce fresh projections. */
  changed(uri?: vscode.Uri): void {
    for (const document of vscode.workspace.textDocuments) if (document.uri.scheme === QUERY_SCHEME
      && (!uri || uri.toString() === document.uri.toString())) this.schedule(document);
    this.render();
  }

  /** Internal projected requests are identified locally, never with extra fields in the LSP protocol. */
  owns(params: unknown): boolean { return typeof params === "object" && params !== null && this.internal.has(params); }

  /** Navigation from any ordinary module must compensate for another module's active projection. */
  async rewriteLocations(value: unknown): Promise<unknown> {
    if (Array.isArray(value)) return (await Promise.all(value.map(item => this.location(item)))).filter(item => item !== undefined);
    return this.location(value);
  }

  /** Debouncing changes never leaves diagnostics or an in-flight response visible for the previous revision. */
  private schedule(document: vscode.TextDocument): void {
    if (this.disposed || !this.tabs.languageState(document)) return;
    void this.remove(document);
    const old = this.timers.get(document); if (old) clearTimeout(old);
    this.state(document, this.unavailable(document));
    this.timers.set(document, setTimeout(() => { this.timers.delete(document); void this.ensure(document); }, 180));
  }

  /** Only one capture per native document can be in flight; stale captures release their backend allocation. */
  private async ensure(document: vscode.TextDocument): Promise<View | undefined> {
    const existing = this.views.get(document);
    if (existing && this.fresh(existing)) return existing;
    const task = this.tasks.get(document); if (task) return task;
    const timer = this.timers.get(document); if (timer) clearTimeout(timer);
    this.timers.delete(document);
    const version = document.version, pending = this.capture(document);
    this.tasks.set(document, pending);
    try { return await pending; } finally {
      if (this.tasks.get(document) === pending) this.tasks.delete(document);
      if (document.version !== version && !document.isClosed) this.schedule(document);
    }
  }

  /** Native facts and the core revision must remain identical across projection allocation and synchronization. */
  private async capture(document: vscode.TextDocument): Promise<View | undefined> {
    await this.remove(document);
    const binding = this.binding, version = document.version, epoch = binding?.epoch();
    const state = this.tabs.languageState(document);
    if (state !== "bsl" || !binding?.valid() || document.isClosed || this.disposed) {
      this.state(document, this.unavailable(document)); return undefined;
    }
    if (binding.indexing()) { this.state(document, "queryAnalysisIndexing"); return undefined; }
    let view: View | undefined;
    try {
      const captured = await this.tabs.languageProjection(document);
      view = { document, version, owner: captured.owner, nativeVersion: captured.owner.version, projection: captured.projection,
        binding, epoch: epoch!, active: true, cancellation: new vscode.CancellationTokenSource() };
      if (!this.fresh(view) || !binding.contains(view.owner.uri.fsPath)) return undefined;
      this.views.set(document, view);
      binding.client.diagnostics?.delete(view.owner.uri);
      this.diagnostics.delete(view.owner.uri);
      await binding.documents.project(view.owner.uri.toString(), view.projection.ownerText, view);
      if (!this.fresh(view)) return undefined;
      this.state(document, binding.limited ? "queryAnalysisLimited" : "queryAnalysisReady");
      void this.pullDiagnostics(view);
      return view;
    } catch (error) {
      if (view) view.active = false;
      this.log(`query_language_paused ${String(error)}`); this.state(document, "queryAnalysisPaused"); return undefined;
    }
    finally {
      if (view && !this.fresh(view)) {
        if (this.views.get(document) === view) this.views.delete(document);
        await this.release(view);
      }
    }
  }

  /** Cancellation and native document identity guard every mapped reply, independently of URI reuse. */
  private fresh(view: View, token?: vscode.CancellationToken): boolean {
    return !this.disposed && view.active && this.binding === view.binding && view.binding.valid() && !view.binding.indexing()
      && view.epoch === view.binding.epoch() && !view.document.isClosed && view.document.version === view.version
      && !view.owner.isClosed && view.owner.version === view.nativeVersion && this.tabs.languageState(view.document) === "bsl"
      && !token?.isCancellationRequested;
  }

  /** Invalidate synchronously so queued requests cannot publish during asynchronous source restoration. */
  private async remove(document: vscode.TextDocument): Promise<void> {
    const timer = this.timers.get(document); if (timer) clearTimeout(timer); this.timers.delete(document);
    const view = this.views.get(document); this.views.delete(document);
    if (!this.disposed) this.diagnostics.delete(document.uri);
    if (view) { view.active = false; view.cancellation.cancel(); await this.release(view); }
  }

  /** Releasing a language view does not close the query session or change its recovery checkpoint. */
  private async release(view: View): Promise<void> {
    if (view.released) return view.released;
    const releasing = this.releaseOnce(view); view.released = releasing; return releasing;
  }

  /** An invalidated view may be observed by teardown and a late capture simultaneously. */
  private async releaseOnce(view: View): Promise<void> {
    view.active = false; view.cancellation.cancel();
    await view.binding.documents.release(view.owner.uri.toString(), view).catch(error => this.log(`query_language_restore ${String(error)}`));
    await view.projection.close().catch(() => {}); view.cancellation.dispose();
    if (this.binding === view.binding && !view.binding.documents.projected(view.owner.uri.toString())) void this.nativeDiagnostics(view.binding, view.owner);
  }

  /** Explicit pull reports have a captured revision; unversioned upstream push reports never address a projected owner. */
  private async pullDiagnostics(view: View): Promise<void> {
    try {
      const value = await this.request(view, "textDocument/diagnostic", {});
      if (!isRecord(value) || value.kind !== "full" || !Array.isArray(value.items)) throw new Error("query_diagnostics_unavailable");
      const items = value.items.filter(item => isRecord(item) && wireRange(item.range)).slice(0, 4096);
      const ranges = await mappedRanges(view.projection, "ownerToDraft", items.map(item => item.range as WireRange));
      const projected: LspDiagnostic[] = [];
      for (let index = 0; index < items.length; index++) {
        const range = ranges[index]; if (!range) continue;
        // Related locations require their own owner mapping and are omitted until that provider is supported.
        const { relatedInformation: _related, ...item } = items[index]!;
        projected.push({ ...item, range } as LspDiagnostic);
      }
      const diagnostics = await view.binding.client.protocol2CodeConverter.asDiagnostics(projected, view.cancellation.token);
      if (this.fresh(view)) {
        this.diagnostics.set(view.document.uri, diagnostics);
        this.state(view.document, view.binding.limited ? "queryAnalysisLimited" : "queryAnalysisReady");
      }
    } catch (error) { if (this.fresh(view)) { this.state(view.document, "queryAnalysisUnavailable"); this.log(`query_diagnostics ${String(error)}`); } }
  }

  /** A restored native owner uses guarded pull diagnostics because delayed push traffic has no trustworthy version. */
  private async nativeDiagnostics(binding: QueryLanguageBinding, document: vscode.TextDocument): Promise<void> {
    const version = document.version, epoch = binding.epoch(), uri = document.uri.toString();
    if (this.disposed || this.binding !== binding || !binding.valid() || document.isClosed || binding.documents.projected(uri) || binding.indexing()) return;
    try {
      await binding.documents.settled(uri);
      const languageEpoch = binding.documents.epoch;
      const value: unknown = await binding.client.sendRequest("textDocument/diagnostic", { textDocument: { uri } });
      if (!isRecord(value) || value.kind !== "full" || !Array.isArray(value.items)) return;
      const diagnostics = await binding.client.protocol2CodeConverter.asDiagnostics(value.items as LspDiagnostic[]);
      if (this.binding === binding && binding.valid() && epoch === binding.epoch() && languageEpoch === binding.documents.epoch && !document.isClosed
        && document.version === version && !binding.documents.projected(uri)) this.diagnostics.set(document.uri, diagnostics);
    } catch { /* A stopped or still-indexing server cannot publish an empty successful report. */ }
  }

  /** All query reads share the existing client and inherit both model cancellation and the view's own revision. */
  private async request(view: View, method: string, extra: Record<string, unknown>, token?: vscode.CancellationToken): Promise<unknown> {
    if (!this.fresh(view, token)) return undefined;
    const cancellation = new vscode.CancellationTokenSource(), a = view.cancellation.token.onCancellationRequested(() => cancellation.cancel()),
      b = token?.onCancellationRequested(() => cancellation.cancel());
    const params = { textDocument: { uri: view.owner.uri.toString() }, ...extra }; this.internal.add(params);
    try {
      await view.binding.documents.settled(view.owner.uri.toString());
      if (!this.fresh(view, token)) return undefined;
      const value: unknown = await view.binding.client.sendRequest(method, params, cancellation.token);
      return this.fresh(view, token) ? value : undefined;
    } finally { this.internal.delete(params); a.dispose(); b?.dispose(); cancellation.dispose(); }
  }

  /** Completion edits are translated by ESKA as a complete set; snippets, commands and owner-side edits are rejected. */
  private async completion(document: vscode.TextDocument, position: vscode.Position, token: vscode.CancellationToken,
    context: vscode.CompletionContext): Promise<vscode.CompletionList | undefined> {
    try {
      const view = await this.ensure(document); if (!view || !this.fresh(view, token)) return undefined;
      const [point] = await view.projection.map("draftToOwner", [position]); if (!point) return undefined;
      const value = await this.request(view, "textDocument/completion", { position: point.position,
        context: { triggerKind: context.triggerKind + 1, ...(context.triggerCharacter ? { triggerCharacter: context.triggerCharacter } : {}) } }, token);
      if (isRecord(value) && value.itemDefaults !== undefined) return undefined;
      const values = Array.isArray(value) ? value : isRecord(value) && Array.isArray(value.items) ? value.items : [];
      const word = document.getWordRangeAtPosition(position) ?? new vscode.Range(position, position);
      const [start, end] = await view.projection.map("draftToOwner", [word.start, word.end]);
      if (!start || !end) return undefined;
      const fallback = { start: start.position, end: end.position };
      const items = await Promise.all(values.slice(0, 200).map(item => this.completionItem(view, item, fallback)));
      return this.fresh(view, token) ? new vscode.CompletionList(items.filter((item): item is vscode.CompletionItem => !!item),
        isRecord(value) && value.isIncomplete === true) : undefined;
    } catch { return undefined; }
  }

  /** Native completion presentation contains only a core-checked SDBL edit and non-executable documentation. */
  private async completionItem(view: View, raw: unknown, fallback: WireRange): Promise<vscode.CompletionItem | undefined> {
    if (!isRecord(raw) || typeof raw.label !== "string" || raw.command || raw.insertTextFormat === 2) return undefined;
    const edit = isRecord(raw.textEdit) ? raw.textEdit : undefined;
    const range = edit ? wireRange(edit.range) ?? wireRange(edit.replace) : fallback;
    const newText = edit ? edit.newText : raw.insertText ?? raw.label;
    if (!range || typeof newText !== "string") return undefined;
    const edits: ProjectedEdit[] = [{ range, newText }];
    if (raw.additionalTextEdits !== undefined) {
      if (!Array.isArray(raw.additionalTextEdits)) return undefined;
      for (const additional of raw.additionalTextEdits) {
        if (!isRecord(additional) || !wireRange(additional.range) || typeof additional.newText !== "string") return undefined;
        edits.push({ range: additional.range as WireRange, newText: additional.newText });
      }
    }
    try {
      const plan = await view.projection.edits(edits), replacement = plan.replacements[0];
      if (!replacement || plan.replacements.length !== 1 || !this.fresh(view)) return undefined;
      const item = new vscode.CompletionItem(raw.label, typeof raw.kind === "number" && raw.kind >= 1 && raw.kind <= 25 ? raw.kind - 1 : undefined);
      item.textEdit = new vscode.TextEdit(nativeRange(replacement.rangeUtf16), replacement.text);
      for (const key of ["detail", "sortText", "filterText"] as const) if (typeof raw[key] === "string") item[key] = raw[key];
      if (typeof raw.documentation === "string") item.documentation = raw.documentation;
      else if (isRecord(raw.documentation) && typeof raw.documentation.value === "string") item.documentation = new vscode.MarkdownString(raw.documentation.value);
      return item;
    } catch { return undefined; }
  }

  /** Hover coordinates use the same immutable projection as completion and diagnostics. */
  private async hover(document: vscode.TextDocument, position: vscode.Position, token: vscode.CancellationToken): Promise<vscode.Hover | undefined> {
    try {
      const view = await this.ensure(document); if (!view) return undefined;
      const [point] = await view.projection.map("draftToOwner", [position]); if (!point) return undefined;
      const value = await this.request(view, "textDocument/hover", { position: point.position }, token);
      if (!isRecord(value) || value.contents === undefined) return undefined;
      const mapped = { ...value }; delete mapped.range;
      if (wireRange(value.range)) {
        const [range] = await mappedRanges(view.projection, "ownerToDraft", [value.range as WireRange]); if (range) mapped.range = range;
      }
      const hover = await view.binding.client.protocol2CodeConverter.asHover(mapped as unknown as LspHover);
      return this.fresh(view, token) ? hover ?? undefined : undefined;
    } catch { return undefined; }
  }

  /** Definitions and references can target either the current SDBL draft or unchanged native code. */
  private async locations(document: vscode.TextDocument, position: vscode.Position, token: vscode.CancellationToken, method: string,
    extra: Record<string, unknown> = {}): Promise<vscode.Location[] | undefined> {
    try {
      const view = await this.ensure(document); if (!view) return undefined;
      const [point] = await view.projection.map("draftToOwner", [position]); if (!point) return undefined;
      const value = await this.request(view, method, { ...extra, position: point.position }, token),
        mapped = await this.rewriteLocations(value), values = Array.isArray(mapped) ? mapped : mapped ? [mapped] : [];
      const locations = values.flatMap(item => {
        if (!isRecord(item)) return [];
        const uri = typeof item.uri === "string" ? item.uri : item.targetUri, range = wireRange(item.range) ?? wireRange(item.targetSelectionRange);
        return typeof uri === "string" && range ? [new vscode.Location(vscode.Uri.parse(uri), nativeRange(range))] : [];
      });
      return this.fresh(view, token) ? locations : undefined;
    } catch { return undefined; }
  }

  /** Core target mapping compensates for literal expansion, including navigation into code after the query. */
  private async location(value: unknown): Promise<unknown> {
    if (!isRecord(value)) return value;
    const uri = typeof value.uri === "string" ? value.uri : value.targetUri;
    if (typeof uri !== "string" || !this.binding?.documents.projected(uri)) return value;
    const view = [...this.views.values()].find(candidate => candidate.owner.uri.toString() === uri && this.fresh(candidate));
    if (!view) return undefined;
    const link = typeof value.targetUri === "string", range = wireRange(link ? value.targetRange : value.range);
    if (!range) return undefined;
    const [start, end] = await view.projection.map("ownerTarget", [range.start, range.end]);
    if (!start || !end || start.target !== end.target || !this.fresh(view)) return undefined;
    const target = start.target === "draft" ? view.document.uri.toString() : uri, mapped = { start: start.position, end: end.position };
    if (!link) return { ...value, uri: target, range: mapped };
    const selection = wireRange(value.targetSelectionRange); if (!selection) return undefined;
    const [a, b] = await view.projection.map("ownerTarget", [selection.start, selection.end]);
    if (!a || !b || a.target !== start.target || b.target !== start.target || !this.fresh(view)) return undefined;
    const result: Record<string, unknown> = { ...value, targetUri: target, targetRange: mapped, targetSelectionRange: { start: a.position, end: b.position } };
    delete result.originSelectionRange; return result;
  }

  /** The status describes available analysis without interpreting an empty report as a completed index. */
  private state(document: vscode.TextDocument, state: MessageKey): void { this.states.set(document, state); this.render(); }

  /** Capability gaps have a distinct explanation from an explicitly paused or conflicted session. */
  private unavailable(document: vscode.TextDocument): MessageKey {
    const state = this.tabs.languageState(document);
    return state === "basic" ? "queryAnalysisBasic" : state === "backend" ? "queryAnalysisBackend" : "queryAnalysisPaused";
  }

  /** Only query tabs display this presentation; ordinary BSL retains its existing language status. */
  private render(): void {
    if (this.disposed) return;
    const document = vscode.window.activeTextEditor?.document;
    if (!document || !this.tabs.languageState(document)) { this.status.hide(); return; }
    this.status.text = message(vscode.env.language, this.states.get(document) ?? "queryAnalysisPaused");
    this.status.tooltip = message(vscode.env.language, "queryAnalysisCoverage"); this.status.show();
  }

  /** Extension shutdown cancels providers and timers; awaited detach owns native synchronization restoration. */
  dispose(): void {
    this.disposed = true; for (const timer of this.timers.values()) clearTimeout(timer); this.timers.clear();
    for (const subscription of this.subscriptions) subscription.dispose(); this.status.dispose(); this.diagnostics.dispose();
  }
}

/** Validate only wire coordinates; all source/query translation belongs to ESKA. */
function wireRange(value: unknown): WireRange | undefined {
  return isRecord(value) && isPosition(value.start) && isPosition(value.end) ? value as WireRange : undefined;
}

/** Bind protocol UTF-16 coordinates to the native editor API. */
function nativeRange(range: WireRange): vscode.Range {
  return new vscode.Range(range.start.line, range.start.character, range.end.line, range.end.character);
}

/** Batch position transport within the shared core limit instead of one RPC per diagnostic endpoint. */
async function mappedRanges(projection: QueryLanguageProjection, direction: "ownerToDraft", ranges: WireRange[]): Promise<(WireRange | undefined)[]> {
  const result: (WireRange | undefined)[] = [];
  for (let offset = 0; offset < ranges.length; offset += 32) {
    const group = ranges.slice(offset, offset + 32), mapped = await projection.map(direction, group.flatMap(range => [range.start, range.end]));
    for (let index = 0; index < group.length; index++) {
      const start = mapped[index * 2], end = mapped[index * 2 + 1];
      result.push(start && end ? { start: start.position, end: end.position } : undefined);
    }
  }
  return result;
}
