import { projectEnabled } from "../protocol.js";
import * as vscode from "vscode";
import { watchFile, unwatchFile } from "node:fs";
import { basename, isAbsolute, join, relative, sep } from "node:path";
import { CloseAction, ErrorAction, LanguageClient, LSPErrorCodes, ResponseError, type Middleware } from "vscode-languageclient/node";
import type { Connection, ConnectionState } from "../connection.js";
import { ExplorerError, isRecord } from "../protocol.js";
import { message, type MessageKey } from "../messages.js";
import type { DiagnosticLog } from "../diagnostics.js";
import { ToolFailure } from "../tooling/contracts.js";
import type { ToolingSetup } from "../tooling/setup.js";
import { analysisContext, analyzerConfiguration, analyzerFailure, libraryFailure, type AnalysisContext, type AnalyzerConfiguration, type LibraryReference } from "./context.js";
import { LanguageProcess } from "./process.js";
import { LanguageProgress } from "./progress.js";
import { InFlightReads } from "./inflight.js";
import { readonlyPattern } from "../support-settings.js";
import { cancellableChoice } from "../tooling/choice.js";
import type { SupportController } from "../support.js";
import { LanguageEdits } from "./edits.js";
import { nativePath } from "../source.js";
import { watchSourceFiles } from "../watch.js";
import { LanguageDocuments } from "./documents.js";
import { languageUri } from "./uri.js";
import { InlayAlignment } from "./inlays.js";
import type { QueryLanguage } from "../query/language.js";

type Ready = Extract<ConnectionState, { kind: "ready" }>;
interface LibraryObservation {
  state: Ready; application: string | undefined; watcher: vscode.Disposable; version: number;
}
interface Session {
  context: AnalysisContext; binary: string; configuration: AnalyzerConfiguration; lease: string; state: Ready;
  client?: LanguageClient; owner?: LanguageProcess; edits?: LanguageEdits; progress?: LanguageProgress; documents?: LanguageDocuments; configurationWatcher?: vscode.FileSystemWatcher;
  observers: vscode.Disposable[]; alignment?: InlayAlignment;
}
const CONFLICTING_EXTENSION = "elishevkirill.bsl-analyzer-lsp";
const SHARED_READS = new Set(["textDocument/documentSymbol", "textDocument/inlayHint"]);

/** Formatting is owned by eska-fmt; no analyzer formatter is registered, including dynamic and on-type routes. */
class EskaLanguageClient extends LanguageClient {
  override registerFeature(feature: Parameters<LanguageClient["registerFeature"]>[0]): void {
    if ("registrationType" in feature && ["textDocument/formatting", "textDocument/rangeFormatting", "textDocument/onTypeFormatting"].includes(feature.registrationType.method)) return;
    super.registerFeature(feature);
  }
}

/** One language session owns its config lease, client, child and generation independently of TreeView visibility. */
export class LanguageService implements vscode.Disposable {
  private target: Ready | undefined;
  private session: Session | undefined;
  private libraryObservation: LibraryObservation | undefined;
  private queue = Promise.resolve();
  private revision = 0;
  private scope: AbortController | undefined;
  private wanted = vscode.workspace.textDocuments.some(document => document.languageId === "bsl");
  private disposed = false;
  private conflict = false;
  private conflictEpoch = 0;
  private modelRevision = 0;
  private readonly reading = new Set<vscode.CancellationTokenSource>();
  private configurationPending = false;
  private activityUpdating = false;
  private activitySignature = "";
  private activityWork: Promise<void> = Promise.resolve();
  private manualWanted = false;
  private configurationReady = Promise.resolve();
  private resumeConfiguration: (() => void) | undefined;
  private configurationTimer: NodeJS.Timeout | undefined;
  private configurationCheck: Promise<void> | undefined;
  private checkRequested = false;
  private readonly delayedDiagnostics = new Map<string, () => void>();
  private readonly subscriptions: vscode.Disposable[] = [];
  private queryLanguage: QueryLanguage | undefined;

  constructor(private readonly context: vscode.ExtensionContext, private readonly connection: Connection,
    private readonly tooling: ToolingSetup, private readonly output: vscode.LogOutputChannel, private readonly log: DiagnosticLog,
    private readonly support: SupportController, private readonly protectSources: (roots: readonly string[]) => void) {
    this.subscriptions.push(vscode.workspace.onDidOpenTextDocument(document => {
      if (document.languageId === "bsl" && this.projectAllows(document.uri) && !this.wanted) { this.wanted = true; void this.restart(false); }
    }));
    this.subscriptions.push(vscode.workspace.onDidChangeTextDocument(event => {
      if (event.contentChanges.length && event.document.languageId === "bsl" && event.document.uri.scheme === "file") {
        this.sourceChanged(event.document.uri.fsPath);
        // Upstream replaces buffer diagnostics after didChange. Clearing them here triggers
        // extra editor requests before that replacement and stalls navigation on large contexts.
      }
    }));
    this.subscriptions.push(connection.onNotification((method, params) => {
      if (method === "analyzer/validationOutput" && isRecord(params)) {
        for (const value of [params.stdout, params.stderr]) if (typeof value === "string" && value) this.log(value.slice(0, 16384), "warn");
      }
      if (method === "metadata/changed" && isRecord(params)) this.metadataChanged(params);
      if (method === "workspace/activityChanged") void this.activityChanged();
    }));
    this.subscriptions.push(vscode.extensions.onDidChange(() => this.refreshConflict()));
    if (!this.refreshConflict(false) && !this.enabled()) this.tooling.analyzerState("suspended", this.text("languageDisabled"));
  }

  /** Translate only presentation strings; protocol identifiers and backend error categories stay stable. */
  private text(key: MessageKey, ...values: string[]): string { return message(vscode.env.language, key, ...values); }

  /** Query views reuse the window's checked application selection without preparing analyzer configuration. */
  get selectedApplication(): string | undefined {
    const state = this.connection.state;
    return state.kind === "ready" ? this.context.workspaceState.get<string>(this.selectionKey(state)) || undefined : undefined;
  }

  /** Query UI can attach after construction; its analysis shares this client's context, process and lifecycle. */
  attachQueries(language: QueryLanguage): void {
    this.queryLanguage = language;
    this.subscriptions.push(this.queryLanguage);
  }

  /** Reuse the metadata watcher's immediate observation; the upstream server owns incremental XML/BSL indexing. */
  sourceChanged(path: string): void {
    const session = this.session;
    if (!session || !session.context.sources.some(source => {
      const local = relative(source.source, path);
      return local === "" || (!isAbsolute(local) && local !== ".." && !local.startsWith(`..${sep}`));
    })) return;
    this.invalidateModel();
    if (session.context.sources.some(source => relative(source.descriptor, path) === "")) this.holdConfiguration();
    if (!/\.bsl$/i.test(path)) this.scheduleConfigurationCheck();
  }

  /** Retain catalog observation through a rejected entry so correcting it can recover the language session. */
  private observeLibrary(reference: LibraryReference | undefined, state: Ready, application: string | undefined): LibraryObservation | undefined {
    this.clearLibraryObservation();
    if (!reference) return undefined;
    const changed = (): void => {
      if (this.libraryObservation !== observation || this.target !== state || this.disposed
        || !vscode.workspace.isTrusted || !this.wanted || !this.enabled() || this.refreshConflict()) return;
      ++observation.version;
      this.invalidateModel(); this.holdConfiguration(); this.scheduleConfigurationCheck();
    };
    const watcher = { dispose: () => unwatchFile(reference.configuration, changed) };
    const observation = { state, application, watcher, version: 0 };
    this.libraryObservation = observation;
    // One small file is polled independently of workspace exclusions and absent parent directories.
    watchFile(reference.configuration, { persistent: false, interval: 1000 }, changed);
    return observation;
  }

  /** Disconnect, manual stop and context selection release even a recovery-only watcher. */
  private clearLibraryObservation(): void {
    this.libraryObservation?.watcher.dispose();
    this.libraryObservation = undefined;
  }

  /** Discovery will replace the metadata session after its debounce; invalidate language results immediately. */
  manifestChanged(): void { this.invalidateModel(); this.holdConfiguration(); }

  /** Backend mutations can precede filesystem delivery; only selected-context project identities affect this session. */
  private metadataChanged(params: Record<string, unknown>): void {
    const session = this.session;
    if (!session || params.sessionId !== session.state.session.sessionId) return;
    const project = session.state.session.projects.find(candidate => candidate.projectId === params.projectId);
    if (!project || !session.context.sources.some(source => source.root === nativePath(project.rootPath))) return;
    this.invalidateModel();
    if (params.supportUnchanged !== true) this.scheduleConfigurationCheck();
  }

  /** A changed root/config cannot publish diagnostics or edits before its authoritative fingerprint is checked. */
  private holdConfiguration(): void {
    if (!this.configurationPending) {
      this.configurationReady = new Promise(resolve => { this.resumeConfiguration = resolve; });
      this.delayedDiagnostics.clear();
      const session = this.session, revision = this.revision, signal = this.scope?.signal, collection = session?.client?.diagnostics;
      if (signal) collection?.forEach((uri, values) => this.bufferDiagnostics(uri,
        () => collection.set(uri, values), () => this.session === session && this.accepts(revision, signal) && this.sourceAllows(uri)));
    }
    this.configurationPending = true;
    this.session?.client?.diagnostics?.clear();
  }

  /** Resume queued reads only after the authoritative configuration is current or this session is retired. */
  private releaseConfiguration(): void {
    this.configurationPending = false;
    this.resumeConfiguration?.();
    this.resumeConfiguration = undefined;
  }

  /** A same-fingerprint event must restore current diagnostics even when upstream correctly emits no new push. */
  private bufferDiagnostics(uri: vscode.Uri, publish: () => void, valid: () => boolean): void {
    const document = vscode.workspace.textDocuments.find(value => value.uri.toString() === uri.toString()), version = document?.version;
    if (this.delayedDiagnostics.size >= 8192) this.delayedDiagnostics.delete(this.delayedDiagnostics.keys().next().value!);
    this.delayedDiagnostics.set(uri.toString(), () => {
      if (valid() && !document?.isClosed && document?.version === version) publish();
    });
  }

  /** Coalesce checks of manifests and root descriptors without scanning modules or starting another index. */
  private scheduleConfigurationCheck(): void {
    if (this.activityUpdating || this.disposed || (!this.session && !this.libraryObservation)) return;
    this.checkRequested = true;
    if (this.configurationTimer || this.configurationCheck) return;
    this.configurationTimer = setTimeout(() => {
      this.configurationTimer = undefined;
      this.checkRequested = false;
      const check = this.inspectConfiguration();
      this.configurationCheck = check;
      void check.finally(() => {
        if (this.configurationCheck !== check) return;
        this.configurationCheck = undefined;
        if (this.checkRequested) this.scheduleConfigurationCheck();
      });
    }, 100);
  }

  /** Keep the current LSP for ordinary XML changes; regenerate only after releasing our lease on changed config inputs. */
  private async inspectConfiguration(): Promise<void> {
    await this.queue;
    const session = this.session, revision = this.revision, signal = this.scope?.signal, model = this.modelRevision;
    if (!session) {
      const observation = this.libraryObservation;
      if (!observation || this.target !== observation.state || this.disposed || !vscode.workspace.isTrusted
        || !this.wanted || !this.enabled() || this.refreshConflict()) return;
      try {
        analyzerConfiguration(await this.connection.analyzerRequest("analyzer/configStatus", {
          start: { value: observation.state.target.path, encoding: "utf-8" },
          ...(observation.application ? { application: observation.application } : {}),
        }, signal));
        if (this.libraryObservation === observation && this.target === observation.state && !this.disposed
          && vscode.workspace.isTrusted && this.wanted && this.enabled() && !this.refreshConflict()) await this.restart(false, observation.application);
      } catch { /* An unchanged rejected entry stays observed without a retry loop or repeated notifications. */ }
      return;
    }
    if (!signal || !this.current(revision, signal)) return;
    try {
      const status = analyzerConfiguration(await this.connection.analyzerRequest("analyzer/configStatus", {
        start: { value: session.context.root, encoding: "utf-8" },
        ...(session.context.name ? { application: session.context.name } : {}),
      }, signal));
      if (this.session !== session || !this.current(revision, signal)) return;
      if (model !== this.modelRevision) { this.checkRequested = true; return; }
      if (status.status !== "current" || status.fingerprint !== session.configuration.fingerprint
        || status.body !== session.configuration.body || status.context !== session.configuration.context
        || status.path !== session.configuration.path) {
        this.log(JSON.stringify({ event: "language_context_changed", status: status.status }));
        await this.restart(false, session.context.name ?? undefined);
      } else {
        this.releaseConfiguration();
        const delayed = [...this.delayedDiagnostics.values()]; this.delayedDiagnostics.clear();
        for (const publish of delayed) publish();
        this.log(JSON.stringify({ event: "language_context_current", pid: session.owner?.child.pid }));
      }
    } catch (error) {
      if (this.session !== session || !this.current(revision, signal)) return;
      const stopping = this.stop(undefined, libraryFailure(error) !== undefined), stoppingRevision = this.revision;
      await stopping;
      if (!this.disposed && this.revision === stoppingRevision && this.target === session.state) this.failure(error);
    }
  }

  private activityKey(state = this.target): string {
    return JSON.stringify(state?.session.projects.map(project => [project.projectId, projectEnabled(project)]));
  }

  private projectAllows(uri: vscode.Uri, state = this.target): boolean {
    if (uri.scheme !== "file") return true;
    const project = state?.session.projects.find(project => {
      const local = relative(nativePath(project.sourcePath), uri.fsPath);
      return local === "" || (!isAbsolute(local) && local !== ".." && !local.startsWith(`..${sep}`));
    });
    return !project || projectEnabled(project);
  }

  private sourceAllows(uri: vscode.Uri): boolean {
    if (!this.projectAllows(uri)) return false;
    if (uri.scheme !== "file") return true;
    return !!this.session?.context.sources.some(source => {
      const local = relative(source.source, uri.fsPath);
      return local === "" || (!isAbsolute(local) && local !== ".." && !local.startsWith(`..${sep}`));
    });
  }

  /** Cancel background startup before the serial backend can be occupied ahead of the activity request. */
  prepareActivityChange(): void {
    this.invalidateModel(); this.holdConfiguration();
    if (!this.session?.client?.isRunning()) this.scope?.abort();
  }

  async activityChangeFailed(): Promise<void> {
    this.releaseConfiguration();
    const delayed = [...this.delayedDiagnostics.values()]; this.delayedDiagnostics.clear();
    for (const publish of delayed) publish();
    if (!this.session || this.scope?.signal.aborted) await this.restart(false);
  }

  /** Update the live upstream source set while preserving the shared process and active consumers. */
  activityChanged(): Promise<void> {
    const signature = this.activityKey();
    if (signature === this.activitySignature) return this.activityWork;
    this.activitySignature = signature;
    this.wanted ||= vscode.workspace.textDocuments.some(document => document.languageId === "bsl" && this.projectAllows(document.uri));
    this.invalidateModel(); this.holdConfiguration(); this.activityUpdating = true;
    clearTimeout(this.configurationTimer); this.configurationTimer = undefined; this.checkRequested = false;
    if (!this.session?.client?.isRunning()) this.scope?.abort();
    let restart = false;
    const work = this.queue.then(async () => {
      const session = this.session, signal = this.scope?.signal, revision = this.revision;
      if (!session || !signal || !this.current(revision, signal)) { restart = true; return; }
      try {
        await session.documents?.reconcileActivity();
        const parameters = { start: { value: session.context.root, encoding: "utf-8" },
          ...(session.context.name ? { application: session.context.name } : {}) };
        const update = await this.connection.analyzerRequest("analyzer/activityUpdate", {
          ...parameters, analyzer: { value: session.binary, encoding: "utf-8" }, leaseId: session.lease, timeoutSeconds: 60,
        });
        const configuration = analyzerConfiguration(update);
        const next = analysisContext(isRecord(update) ? update.analysisContext : undefined);
        if (next.root !== session.context.root || next.name !== session.context.name) throw new ExplorerError("obsolete");
        if (!configuration.lease) throw new ExplorerError("protocolInvalid");
        session.configuration = configuration; session.lease = configuration.lease;
        if (!this.current(revision, signal) || this.session !== session) return;
        Object.assign(session.context, next);
        await session.client?.sendNotification("workspace/didChangeWatchedFiles", { changes: [{ uri: vscode.Uri.file(configuration.path).toString(), type: 2 }] });
        this.observeSources(session, () => { this.invalidateModel(); this.holdConfiguration(); this.scheduleConfigurationCheck(); }, revision, signal);
        await session.documents?.reconcileActivity();
        this.log(JSON.stringify({ event: "language_activity_updated", pid: session.owner?.child.pid, sources: next.sources.map(source => source.source) }));
      } catch (error) {
        await this.cleanup();
        if (error instanceof ExplorerError && error.domain === "workspace_inactive") { this.clearLibraryObservation(); this.tooling.analyzerState("suspended", this.text("languageWorkspaceInactive")); }
        else this.failure(error);
      } finally {
        this.activityUpdating = false; this.releaseConfiguration();
        const delayed = [...this.delayedDiagnostics.values()]; this.delayedDiagnostics.clear();
        for (const publish of delayed) publish();
      }
    }).finally(() => { this.activityUpdating = false; this.releaseConfiguration(); });
    this.queue = work.catch(error => this.failure(error));
    this.activityWork = this.queue.then(async () => { if (restart && !this.disposed && this.target) await this.restart(false); });
    return this.activityWork;
  }

  private observeSources(session: Session, changed: (uri: vscode.Uri) => void, revision: number, signal: AbortSignal): void {
    for (const observer of session.observers) observer.dispose(); session.observers = [];
    for (const source of session.context.sources) {
      if (session.state.session.projects.some(project => projectEnabled(project) && nativePath(project.sourcePath) === source.source)) continue;
      session.observers.push(watchSourceFiles(source.source, path => {
        if (this.session === session && this.current(revision, signal)) this.sourceChanged(path);
      }));
      const manifest = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(vscode.Uri.file(source.root), "eska.toml"));
      session.observers.push(manifest);
      manifest.onDidCreate(changed); manifest.onDidChange(changed); manifest.onDidDelete(changed);
    }
  }

  /** A metadata connection supplies context authority and owns the lease; its loss invalidates language results. */
  connectionChanged(state: ConnectionState): void {
    const target = state.kind === "ready" ? state : undefined;
    if (target !== this.target) {
      this.clearLibraryObservation();
      this.wanted = this.manualWanted || vscode.workspace.textDocuments.some(document => document.languageId === "bsl" && this.projectAllows(document.uri, target));
    }
    this.activitySignature = this.activityKey(target);
    this.target = target;
    if (this.target) void this.restart(false);
    else if (this.session || this.scope) void this.stop(this.text("languageNoContext"));
  }

  /** A manual restart can start analysis before a BSL document opens; ordinary tree activation stays lazy. */
  restart(manual = true, application?: string, switchContext = false): Promise<void> {
    if (this.disposed) return this.queue;
    this.clearLibraryObservation();
    if (manual) { this.wanted = true; this.manualWanted = true; }
    this.refreshConflict(false);
    const revision = ++this.revision;
    this.invalidateModel(); this.releaseConfiguration(); this.delayedDiagnostics.clear();
    clearTimeout(this.configurationTimer); this.configurationTimer = undefined; this.checkRequested = false;
    this.scope?.abort();
    const controller = new AbortController(); this.scope = controller;
    const state = this.target;
    if (!this.conflict && this.wanted && this.enabled()) this.tooling.analyzerState("starting", this.text("languagePreparing"));
    this.queue = this.queue.then(async () => {
      await this.cleanup();
      if (!this.fresh(revision, controller.signal)) return;
      if (this.refreshConflict()) {
        // A read-only binary probe keeps the installed version visible without preparing a config or offering installation.
        await this.tooling.ensureAnalyzer(controller.signal, false);
        this.refreshConflict();
        return;
      }
      if (!this.current(revision, controller.signal)) return;
      if (!vscode.workspace.isTrusted || !this.enabled() || !this.wanted || !state || !state.analyzerConfiguration || state.target.backend === "legacy") {
        await this.tooling.ensureAnalyzer(controller.signal, false);
        if (!this.current(revision, controller.signal)) return;
        if (!vscode.workspace.isTrusted || !this.enabled()) this.tooling.analyzerState("suspended", this.text("languageDisabled"));
        else if (!this.wanted) this.tooling.analyzerState(this.tooling.states.analyzer.info ? "verified" : "missing");
        else this.tooling.analyzerState("suspended", this.text(state ? "languageLegacy" : "languageNoContext"));
        return;
      }
      if (state !== this.target) return;
      await this.start(state, revision, controller.signal, application, switchContext);
    }).catch(error => {
      if (this.current(revision, controller.signal)) this.failure(error);
    });
    return this.queue;
  }

  /** Stop the child before releasing its config lease; replacing the metadata connection must await this method. */
  stop(detail?: string, retainLibraryObservation = false): Promise<void> {
    if (!retainLibraryObservation) this.clearLibraryObservation();
    ++this.revision; this.scope?.abort(); this.scope = undefined;
    this.invalidateModel(); this.releaseConfiguration(); this.delayedDiagnostics.clear();
    clearTimeout(this.configurationTimer); this.configurationTimer = undefined; this.checkRequested = false;
    if (this.refreshConflict(false)) this.showConflictState();
    else if (detail) this.tooling.analyzerState("suspended", detail);
    else if (["ready", "starting"].includes(this.tooling.states.analyzer.phase)) this.tooling.analyzerState(this.tooling.states.analyzer.info ? "verified" : "missing");
    this.queue = this.queue.then(() => this.cleanup()).catch(error => this.failure(error));
    return this.queue;
  }

  /** Context names are validated by the backend; choosing a name never parses or rewrites eska.toml in TypeScript. */
  async selectContext(): Promise<void> {
    const state = this.target;
    if (!state || !this.enabled() || this.refreshConflict()) return;
    const value = await vscode.window.showInputBox({ title: this.text("languageChoose"), prompt: this.text("languageChooseHint"),
      value: this.context.workspaceState.get<string>(this.selectionKey(state), ""), ignoreFocusOut: true });
    if (value === undefined || state !== this.target || this.disposed) return;
    await this.restart(true, value.trim(), true);
  }

  /** Acquire a checked context before asking for a server or writing its derived configuration. */
  private async start(state: Ready, revision: number, signal: AbortSignal, requested: string | undefined, switchContext: boolean): Promise<void> {
    const selected = requested ?? this.context.workspaceState.get<string>(this.selectionKey(state));
    let application = selected || undefined;
    const parameters = (): Record<string, unknown> => ({ start: { value: state.target.path, encoding: "utf-8" }, ...(application ? { application } : {}) });
    this.tooling.analyzerState("starting", this.text("languagePreparing"));
    const resolveContext = async (): Promise<unknown> => {
      try { return await this.connection.analyzerRequest("analyzer/context", parameters(), signal); }
      catch (error) {
        const reference = libraryFailure(error);
        if (reference && this.current(revision, signal)) {
          this.observeLibrary(reference, state, application);
          // Close the read/observe startup gap even if the file appeared before the first stat sample.
          this.scheduleConfigurationCheck();
        }
        throw error;
      }
    };
    let resolved: unknown;
    try { resolved = await resolveContext(); }
    catch (error) {
      if (error instanceof ExplorerError && error.domain === "workspace_inactive") { this.tooling.analyzerState("suspended", this.text("languageWorkspaceInactive")); return; }
      const data = error instanceof ExplorerError && isRecord(error.details?.data) ? error.details.data : undefined;
      if (analyzerFailure(error) !== "context" || !Array.isArray(data?.available)
        || !data.available.every(name => typeof name === "string" && name)) throw error;
      const choice = await cancellableChoice(vscode.window.showQuickPick(data.available as string[], { placeHolder: this.text("languageChoose"), ignoreFocusOut: true }), signal);
      if (!choice || !this.current(revision, signal)) { if (this.current(revision, signal)) this.tooling.analyzerState("suspended", this.text("languageStopped")); return; }
      application = choice;
      resolved = await resolveContext();
    }
    if (!this.current(revision, signal)) return;
    const context = analysisContext(resolved);
    const observation = this.observeLibrary(context.sources.find(source => source.library)?.library, state, application);
    // These read-only checks share no mutable state. Await both even on failure so
    // an interrupted startup cannot abandon its binary probe or pending RPC.
    const [binary, configuration] = await Promise.allSettled([
      this.tooling.ensureAnalyzer(signal, true),
      this.connection.analyzerRequest("analyzer/configStatus", parameters(), signal),
    ]);
    if (!this.current(revision, signal) || (observation && observation.version !== 0)) return;
    if (binary.status === "rejected") throw binary.reason;
    const info = binary.value;
    if (!info) return;
    this.tooling.analyzerState("starting", this.text("languagePreparing"));
    if (configuration.status === "rejected") throw configuration.reason;
    const status = analyzerConfiguration(configuration.value);
    if (status.status === "migration_required" || status.status === "managed_conflict") throw new ToolFailure("incompatible", status.status);
    if (status.status === "context_conflict" && !switchContext) {
      const choice = await cancellableChoice(vscode.window.showWarningMessage(this.text("languageSwitch", context.name ?? basename(context.root)), this.text("languageSwitchAction")), signal);
      if (!choice || !this.current(revision, signal)) { if (this.current(revision, signal)) this.tooling.analyzerState("suspended", this.text("languageStopped")); return; }
      switchContext = true;
    }
    // A current owned config was validated before publication. Acquire rechecks its inputs
    // under the lease; only changed/missing configurations need another upstream check-config.
    const prepared = status.status === "current" ? status
      : analyzerConfiguration(await this.connection.analyzerRequest("analyzer/configPrepare", { ...parameters(),
        analyzer: { value: info.path, encoding: "utf-8" }, timeoutSeconds: 60, switchContext }, signal));
    if (!this.current(revision, signal)) return;
    // Acquire is a side-effect boundary: receive its identity even after cancellation, then release it in cleanup.
    const lease = analyzerConfiguration(await this.connection.analyzerRequest("analyzer/acquire", parameters()));
    if (!lease.lease) throw new ExplorerError("protocolInvalid");
    const session: Session = { context, binary: info.path, configuration: lease, lease: lease.lease, state, observers: [] }; this.session = session;
    let started = false;
    try {
      if (!this.current(revision, signal) || (observation && observation.version !== 0)) return;
      if (prepared.status !== "current" || lease.status !== "current" || prepared.path !== join(context.root, "bsl-analyzer.toml")
        || prepared.path !== lease.path || prepared.context !== context.name || lease.context !== context.name
        || prepared.fingerprint !== lease.fingerprint || prepared.body !== lease.body || prepared.token !== lease.token) throw new ExplorerError("obsolete");
      if (observation) {
        const renewed = analysisContext(await resolveContext());
        if (!this.current(revision, signal)) return;
        if (JSON.stringify(renewed) !== JSON.stringify(context)) { this.scheduleConfigurationCheck(); return; }
      }
      const middleware = this.readingMiddleware(revision, signal);
      session.progress = new LanguageProgress(() => this.current(revision, signal), () => this.queryLanguage?.changed());
      middleware.handleWorkDoneProgress = session.progress.handle;
      const client = new EskaLanguageClient("eska-bsl", "BSL Analyzer (ESKA Explorer)", async () => {
        if (!this.current(revision, signal)) throw new ExplorerError("obsolete");
        session.owner = new LanguageProcess(info.path, context.root, this.log, () => {
          if (!this.current(revision, signal)) return;
          this.failure(new ToolFailure("probe", "language-process-exit")); void this.stop();
        }, signal);
        return { reader: session.owner.child.stdout, writer: session.owner.child.stdin };
      }, {
        // Match VS Code's normalized drive letter rather than the backend's native path spelling.
        documentSelector: [...new Set([...context.sources.map(source => source.source), ...state.session.projects.map(project => nativePath(project.sourcePath))])].map(source => ({ scheme: "file", language: "bsl",
          pattern: readonlyPattern(vscode.Uri.file(source).fsPath).replace(/\/$/, "") + "/**/*.[bB][sS][lL]" })),
        workspaceFolder: { uri: vscode.Uri.file(context.root), name: context.name ?? basename(context.root), index: 0 },
        uriConverters: { code2Protocol: uri => languageUri(uri.toString()), protocol2Code: value => vscode.Uri.parse(value) },
        diagnosticCollectionName: "eska-bsl", outputChannel: this.output,
        initializationFailedHandler: () => false, connectionOptions: { maxRestartCount: 0 },
        errorHandler: { error: () => ({ action: ErrorAction.Shutdown, handled: true }), closed: () => ({ action: CloseAction.DoNotRestart, handled: true }) },
        middleware,
      });
      session.client = client;
      if (state.multilineStrings) session.alignment = new InlayAlignment(vscode, state.multilineStrings,
        () => this.session === session && this.accepts(revision, signal),
        () => {
          const events = new Set<vscode.EventEmitter<void>>();
          for (const document of vscode.workspace.textDocuments) {
            const provider = client.getFeature("textDocument/inlayHint").getProvider(document);
            if (provider) events.add(provider.onDidChangeInlayHints);
          }
          for (const event of events) event.fire();
        },
        document => client.getFeature("textDocument/inlayHint").getProvider(document)?.provider.resolveInlayHint !== undefined,
        () => session.documents?.epoch);
      session.documents = new LanguageDocuments((method, params) => client.sendNotification(method, params),
        uri => vscode.workspace.textDocuments.find(document => languageUri(document.uri.toString()) === uri && !document.isClosed), uri => this.sourceAllows(vscode.Uri.parse(uri)));
      session.edits = new LanguageEdits(client, context, this.support, () => this.accepts(revision, signal), this.log, () => this.modelRevision,
        document => session.documents?.wireVersion(document));
      Object.assign(middleware, session.edits.middleware());
      const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(vscode.Uri.file(context.root), "bsl-analyzer.toml"));
      session.configurationWatcher = watcher;
      /** Observe managed-config changes without replacing the metadata session or parsing TOML in the editor. */
      const changed = (uri: vscode.Uri): void => {
        if (this.activityUpdating || uri.scheme !== "file" || this.session !== session || !this.current(revision, signal)) return;
        this.invalidateModel(); this.holdConfiguration(); this.scheduleConfigurationCheck();
      };
      watcher.onDidCreate(changed); watcher.onDidChange(changed); watcher.onDidDelete(changed);
      this.observeSources(session, changed, revision, signal);
      this.protectSources(context.sources.filter(source => !state.session.projects.some(project => nativePath(project.rootPath) === source.root))
        .map(source => source.root));
      if (!this.current(revision, signal)) return;
      await client.start();
      if (!this.current(revision, signal) || (observation && observation.version !== 0)) return;
      if (client.initializeResult?.serverInfo?.name !== "bsl-analyzer" || client.initializeResult.serverInfo.version !== info.version) throw new ToolFailure("incompatible", "lsp-server-info");
      await this.context.workspaceState.update(this.selectionKey(state), context.name ?? undefined);
      if (!this.current(revision, signal)) return;
      started = true;
      this.queryLanguage?.attach({ client, documents: session.documents, limited: context.limited, valid: () => this.accepts(revision, signal), epoch: () => this.modelRevision,
        indexing: () => session.progress?.busy === true, contains: path => context.sources.some(source => {
          const local = relative(source.source, path);
          return local === "" || (!isAbsolute(local) && local !== ".." && !local.startsWith(`..${sep}`));
        }) });
      this.tooling.analyzerState("ready", context.limited ? this.text("languageLimited", context.name ?? basename(context.root)) : context.name ?? basename(context.root));
      this.log(JSON.stringify({ event: "language_ready", pid: session.owner?.child.pid, root: context.root, application: context.name,
        fingerprint: lease.fingerprint, capabilities: client.initializeResult.capabilities }));
    } finally { if (!started) await this.cleanup(); }
  }

  /** Discard reads from replaced servers or changed/closed buffers; writing routes have their own complete-edit guard. */
  private readingMiddleware(revision: number, signal: AbortSignal): Middleware {
    // URI/version pairs may recur after closing a buffer; its editor document identity must remain distinct.
    const shared = new WeakMap<vscode.TextDocument, InFlightReads>();
    /** The generic client middleware expects a protocol cancellation, which it handles without an error notification. */
    const cancelled = () => new ResponseError(LSPErrorCodes.RequestCancelled, "request_cancelled");
    const read = async <T>(document: vscode.TextDocument, token: vscode.CancellationToken, action: () => vscode.ProviderResult<T>): Promise<T | undefined> => {
      const version = document.version;
      if (!this.sourceAllows(document.uri)) return undefined;
      while (this.configurationPending && this.current(revision, signal) && !token.isCancellationRequested) {
        // Returning an empty outline during this barrier makes VS Code cache it for the unchanged buffer.
        const cancellation = new AbortController(), subscription = token.onCancellationRequested(() => cancellation.abort());
        try { await cancellableChoice(this.configurationReady, AbortSignal.any([signal, cancellation.signal])); }
        finally { subscription.dispose(); }
      }
      const model = this.modelRevision, documents = this.session?.documents, languageEpoch = documents?.epoch;
      if (document.isClosed || document.version !== version || !this.sourceAllows(document.uri)) return undefined;
      if (!this.accepts(revision, signal) || token.isCancellationRequested || documents?.projected(document.uri.toString())) return undefined;
      const value = await action();
      return this.accepts(revision, signal) && model === this.modelRevision && languageEpoch === documents?.epoch
        && !document.isClosed && document.version === version && !token.isCancellationRequested ? value ?? undefined : undefined;
    };
    return {
      sendNotification: (type, next, params) => {
        const documents = this.session?.documents, method = typeof type === "string" ? type : type.method;
        return documents ? documents.notification(method, params, value => next(type, value as typeof params)) : next(type, params);
      },
      sendRequest: async (type, params, token, next) => {
        const model = this.modelRevision;
        const uri = isRecord(params) && isRecord(params.textDocument) ? params.textDocument.uri : undefined;
        const document = typeof uri === "string" ? vscode.workspace.textDocuments.find(value => languageUri(value.uri.toString()) === languageUri(uri)) : undefined;
        const version = document?.version;
        const documents = this.session?.documents, internal = this.queryLanguage?.owns(params);
        const languageEpoch = documents?.epoch;
        if (typeof uri === "string" && !this.sourceAllows(vscode.Uri.parse(uri))) throw cancelled();
        if (!internal && typeof uri === "string" && documents?.projected(uri)) throw cancelled();
        if (!this.accepts(revision, signal) || token?.isCancellationRequested) throw cancelled();
        const cancellation = new vscode.CancellationTokenSource();
        const subscription = token?.onCancellationRequested(() => cancellation.cancel());
        this.reading.add(cancellation);
        const method = typeof type === "string" ? type : type.method;
        const key = document && SHARED_READS.has(method) ? JSON.stringify([method, model, languageEpoch, version, params]) : undefined;
        let readers: InFlightReads | undefined;
        if (key && document) {
          readers = shared.get(document);
          if (!readers) {
            readers = new InFlightReads(() => new vscode.CancellationTokenSource(), cancelled);
            shared.set(document, readers);
          }
        }
        try {
          /** Shared callers use a common upstream token while keeping individual freshness checks. */
          const send = (requestToken: vscode.CancellationToken) => {
            if (requestToken.isCancellationRequested || !this.accepts(revision, signal)
              || model !== this.modelRevision || languageEpoch !== documents?.epoch || document?.isClosed || document?.version !== version) throw cancelled();
            return next(type, params, requestToken);
          };
          if (typeof uri === "string") await documents?.settled(uri);
          if (typeof uri === "string" && !this.sourceAllows(vscode.Uri.parse(uri))) throw cancelled();
        if (!internal && typeof uri === "string" && documents?.projected(uri)) throw cancelled();
          const value = await (key && readers ? readers.read(key, cancellation.token, send) : send(cancellation.token));
          if (!this.accepts(revision, signal) || model !== this.modelRevision || languageEpoch !== documents?.epoch || token?.isCancellationRequested
            || document?.isClosed || document?.version !== version) throw cancelled();
          if (!internal && ["textDocument/definition", "textDocument/typeDefinition", "textDocument/references", "textDocument/implementation"].includes(method)
            && this.queryLanguage) {
            const mapped = await this.queryLanguage.rewriteLocations(value);
            if (!this.accepts(revision, signal) || model !== this.modelRevision || languageEpoch !== documents?.epoch
              || token?.isCancellationRequested || document?.isClosed || document?.version !== version) throw cancelled();
            return mapped as typeof value;
          }
          return value;
        } finally {
          this.reading.delete(cancellation); subscription?.dispose(); cancellation.dispose();
        }
      },
      provideInlayHints: (doc, range, token, next) => read(doc, token, () => this.session?.alignment
        ? this.session.alignment.provide(doc, range, token, next) : next(doc, range, token)),
      provideHover: (doc, pos, token, next) => read(doc, token, () => next(doc, pos, token)),
      provideDefinition: (doc, pos, token, next) => read(doc, token, () => next(doc, pos, token)),
      provideTypeDefinition: (doc, pos, token, next) => read(doc, token, () => next(doc, pos, token)),
      provideReferences: (doc, pos, context, token, next) => read(doc, token, () => next(doc, pos, context, token)),
      provideDocumentSymbols: (doc, token, next) => read(doc, token, () => next(doc, token)),
      provideCompletionItem: (doc, pos, context, token, next) => read(doc, token, () => next(doc, pos, context, token)),
      provideSignatureHelp: (doc, pos, context, token, next) => read(doc, token, () => next(doc, pos, context, token)),
      provideDocumentSemanticTokens: (doc, token, next) => read(doc, token, () => next(doc, token)),
      handleDiagnostics: (uri, values, next) => {
        if (!this.current(revision, signal) || !this.sourceAllows(uri)) return;
        if (this.session?.documents?.poisoned(uri.toString())) return;
        if (this.configurationPending) {
          this.bufferDiagnostics(uri, () => next(uri, values), () => this.accepts(revision, signal) && this.sourceAllows(uri));
        } else next(uri, values);
      },
    };
  }

  /** Stop obsolete upstream work immediately instead of waiting for its result merely to discard it. */
  private invalidateModel(): void {
    ++this.modelRevision;
    this.session?.alignment?.invalidate();
    for (const request of this.reading) request.cancel();
    this.queryLanguage?.changed();
  }

  /** Release resources in lease order even if the protocol peer ignores its normal shutdown request. */
  private async cleanup(): Promise<void> {
    const session = this.session;
    if (!session) return;
    session.alignment?.dispose();
    await this.queryLanguage?.detach();
    session.configurationWatcher?.dispose();
    session.progress?.dispose();
    for (const observer of session.observers) observer.dispose();
    await session.edits?.shutdown();
    try { await session.client?.stop(4000); } catch { this.log("language_shutdown_failed", "warn"); }
    await session.owner?.stop();
    await session.client?.dispose(1000).catch(() => this.log("language_client_dispose_failed", "warn"));
    if (this.connection.state === session.state) {
      await this.connection.analyzerRequest("analyzer/release", { leaseId: session.lease }).catch(error => { if (!(error instanceof ExplorerError && error.domain === "unknown_analyzer_lease")) this.log(`language_lease_release_failed ${String(error)}`, "warn"); });
    }
    if (this.session === session) this.session = undefined;
  }

  /** Settings affect only Explorer's language client, not grammar registration or foreign extensions. */
  private enabled(): boolean { return vscode.workspace.getConfiguration("eska.explorer").get<boolean>("languageFeatures", true); }

  /** Public getExtension is limited to this host and includes enabled extensions which have not activated yet. */
  private refreshConflict(resume = true): boolean {
    if (this.disposed) return this.conflict;
    const conflict = vscode.extensions.getExtension(CONFLICTING_EXTENSION) !== undefined;
    if (conflict !== this.conflict) {
      this.conflict = conflict;
      const epoch = ++this.conflictEpoch;
      if (conflict) {
        this.showConflictState();
        this.log(JSON.stringify({ event: "language_conflict", extension: CONFLICTING_EXTENSION }));
        void Promise.resolve(vscode.window.showWarningMessage(this.text("languageConflictWarning", CONFLICTING_EXTENSION),
          this.text("languageManageExtension"), this.text("languageUseExternal"))).then(async choice => {
          if (choice === this.text("languageManageExtension") && !this.disposed && epoch === this.conflictEpoch && this.conflict) {
            await vscode.commands.executeCommand("workbench.extensions.search", `@id:${CONFLICTING_EXTENSION}`);
          }
        }).catch(() => this.log("language_conflict_notification_failed", "warn"));
      }
      if (resume) void this.restart(false);
    }
    if (conflict && this.tooling.states.analyzer.phase !== "suspended-conflict") this.showConflictState();
    return conflict;
  }

  /** A persistent reason survives dismissed warnings, binary probes and independent component updates. */
  private showConflictState(): void {
    this.tooling.analyzerState("suspended-conflict", this.text("languageConflictDetail", CONFLICTING_EXTENSION));
  }

  /** A blocked client still permits an independent read-only binary probe in its current generation. */
  private fresh(revision: number, signal: AbortSignal): boolean { return !this.disposed && revision === this.revision && !signal.aborted; }

  /** The selected root and its API session are rechecked after every asynchronous boundary. */
  private current(revision: number, signal: AbortSignal): boolean {
    if (!this.fresh(revision, signal)) return false;
    return !this.refreshConflict() && this.fresh(revision, signal);
  }

  /** Lifecycle can finish a recheck while language operations wait for the selected configuration. */
  private accepts(revision: number, signal: AbortSignal): boolean { return !this.configurationPending && this.current(revision, signal); }

  /** Keep a stable per-window selection without copying manifest topology into editor settings. */
  private selectionKey(state: Ready): string { return `analysisContext.${state.target.path}`; }

  /** Failures leave metadata running and never trigger an automatic restart loop. */
  private failure(error: unknown): void {
    if (this.disposed) return;
    const code = analyzerFailure(error) ?? (error instanceof ToolFailure ? error.detail || error.code : error instanceof ExplorerError ? error.code : "language");
    this.log(JSON.stringify({ event: "language_failed", code }), "error");
    if (this.refreshConflict()) { this.showConflictState(); return; }
    const library = libraryFailure(error);
    const detail = library ? this.text("languageLibraryFailed", library.name, library.configuration)
      : code === "migration_required" ? this.text("languageMigrationRequired") : code === "managed_conflict" ? this.text("languageManagedConflict") : this.text("languageFailed", code);
    this.tooling.analyzerState("error", detail);
    void vscode.window.showErrorMessage(detail);
  }

  /** Await owned cleanup before the extension's shared output channel is disposed. */
  async shutdown(): Promise<void> { this.dispose(); await this.stop(); }

  /** The synchronous hook invalidates late work immediately; shutdown owns the awaited teardown. */
  dispose(): void { if (!this.disposed) { this.disposed = true; this.clearLibraryObservation(); ++this.revision; this.scope?.abort(); for (const value of this.subscriptions) value.dispose(); } }
}
