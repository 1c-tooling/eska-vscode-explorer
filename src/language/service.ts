import * as vscode from "vscode";
import { basename, isAbsolute, join, relative, sep } from "node:path";
import { CloseAction, ErrorAction, LanguageClient, LSPErrorCodes, ResponseError, type Middleware } from "vscode-languageclient/node";
import type { Connection, ConnectionState } from "../connection.js";
import { ExplorerError, isRecord } from "../protocol.js";
import { message, type MessageKey } from "../messages.js";
import type { DiagnosticLog } from "../diagnostics.js";
import { ANALYZER_VERSION, ToolFailure } from "../tooling/contracts.js";
import type { ToolingSetup } from "../tooling/setup.js";
import { analysisContext, analyzerConfiguration, analyzerFailure, type AnalysisContext, type AnalyzerConfiguration } from "./context.js";
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
import type { QueryLanguage } from "../query/language.js";

type Ready = Extract<ConnectionState, { kind: "ready" }>;
interface Session {
  context: AnalysisContext; configuration: AnalyzerConfiguration; lease: string; state: Ready;
  client?: LanguageClient; owner?: LanguageProcess; edits?: LanguageEdits; progress?: LanguageProgress; documents?: LanguageDocuments; configurationWatcher?: vscode.FileSystemWatcher;
  observers: vscode.Disposable[];
}
const CONFLICTING_EXTENSION = "elishevkirill.bsl-analyzer-lsp";
const SHARED_READS = new Set(["textDocument/documentSymbol", "textDocument/inlayHint"]);

/** One language session owns its config lease, client, child and generation independently of TreeView visibility. */
export class LanguageService implements vscode.Disposable {
  private target: Ready | undefined;
  private session: Session | undefined;
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
      if (document.languageId === "bsl" && !this.wanted) { this.wanted = true; void this.restart(false); }
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
    if (session.context.sources.some(source => source.descriptor === path)) this.holdConfiguration();
    if (!/\.bsl$/i.test(path)) this.scheduleConfigurationCheck();
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
      this.delayedDiagnostics.clear();
      const session = this.session, revision = this.revision, signal = this.scope?.signal, collection = session?.client?.diagnostics;
      if (signal) collection?.forEach((uri, values) => this.bufferDiagnostics(uri,
        () => collection.set(uri, values), () => this.session === session && this.accepts(revision, signal)));
    }
    this.configurationPending = true;
    this.session?.client?.diagnostics?.clear();
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
    if (this.disposed || !this.session) return;
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
    if (!session || !signal || !this.current(revision, signal)) return;
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
        this.configurationPending = false;
        const delayed = [...this.delayedDiagnostics.values()]; this.delayedDiagnostics.clear();
        for (const publish of delayed) publish();
        this.log(JSON.stringify({ event: "language_context_current", pid: session.owner?.child.pid }));
      }
    } catch (error) {
      if (this.session !== session || !this.current(revision, signal)) return;
      const stopping = this.stop(), stoppingRevision = this.revision;
      await stopping;
      if (!this.disposed && this.revision === stoppingRevision && this.target === session.state) this.failure(error);
    }
  }

  /** A metadata connection supplies context authority and owns the lease; its loss invalidates language results. */
  connectionChanged(state: ConnectionState): void {
    this.target = state.kind === "ready" ? state : undefined;
    if (this.target) void this.restart(false);
    else if (this.session || this.scope) void this.stop(this.text("languageNoContext"));
  }

  /** A manual restart can start analysis before a BSL document opens; ordinary tree activation stays lazy. */
  restart(manual = true, application?: string, switchContext = false): Promise<void> {
    if (this.disposed) return this.queue;
    if (manual) this.wanted = true;
    this.refreshConflict(false);
    const revision = ++this.revision;
    this.invalidateModel(); this.configurationPending = false; this.delayedDiagnostics.clear();
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
  stop(detail?: string): Promise<void> {
    ++this.revision; this.scope?.abort(); this.scope = undefined;
    this.invalidateModel(); this.configurationPending = false; this.delayedDiagnostics.clear();
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
    let resolved: unknown;
    try { resolved = await this.connection.analyzerRequest("analyzer/context", parameters(), signal); }
    catch (error) {
      const data = error instanceof ExplorerError && isRecord(error.details?.data) ? error.details.data : undefined;
      if (analyzerFailure(error) !== "context" || !Array.isArray(data?.available)
        || !data.available.every(name => typeof name === "string" && name)) throw error;
      const choice = await cancellableChoice(vscode.window.showQuickPick(data.available as string[], { placeHolder: this.text("languageChoose"), ignoreFocusOut: true }), signal);
      if (!choice || !this.current(revision, signal)) { if (this.current(revision, signal)) this.tooling.analyzerState("suspended", this.text("languageStopped")); return; }
      application = choice;
      resolved = await this.connection.analyzerRequest("analyzer/context", parameters(), signal);
    }
    if (!this.current(revision, signal)) return;
    const context = analysisContext(resolved);
    // These read-only checks share no mutable state. Await both even on failure so
    // an interrupted startup cannot abandon its binary probe or pending RPC.
    const [binary, configuration] = await Promise.allSettled([
      this.tooling.ensureAnalyzer(signal, true),
      this.connection.analyzerRequest("analyzer/configStatus", parameters(), signal),
    ]);
    if (!this.current(revision, signal)) return;
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
    const session: Session = { context, configuration: lease, lease: lease.lease, state, observers: [] }; this.session = session;
    let started = false;
    try {
      if (!this.current(revision, signal)) return;
      if (prepared.status !== "current" || lease.status !== "current" || prepared.path !== join(context.root, "bsl-analyzer.toml")
        || prepared.path !== lease.path || prepared.context !== context.name || lease.context !== context.name
        || prepared.fingerprint !== lease.fingerprint || prepared.body !== lease.body || prepared.token !== lease.token) throw new ExplorerError("obsolete");
      const middleware = this.readingMiddleware(revision, signal);
      session.progress = new LanguageProgress(() => this.current(revision, signal), () => this.queryLanguage?.changed());
      middleware.handleWorkDoneProgress = session.progress.handle;
      const client = new LanguageClient("eska-bsl", "BSL Analyzer (ESKA Explorer)", async () => {
        if (!this.current(revision, signal)) throw new ExplorerError("obsolete");
        session.owner = new LanguageProcess(info.path, context.root, this.log, () => {
          if (!this.current(revision, signal)) return;
          this.failure(new ToolFailure("probe", "language-process-exit")); void this.stop();
        }, signal);
        return { reader: session.owner.child.stdout, writer: session.owner.child.stdin };
      }, {
        documentSelector: context.sources.map(source => ({ scheme: "file", language: "bsl", pattern: readonlyPattern(source.source).replace(/\/$/, "") + "/**/*.[bB][sS][lL]" })),
        workspaceFolder: { uri: vscode.Uri.file(context.root), name: context.name ?? basename(context.root), index: 0 },
        diagnosticCollectionName: "eska-bsl", outputChannel: this.output,
        initializationFailedHandler: () => false, connectionOptions: { maxRestartCount: 0 },
        errorHandler: { error: () => ({ action: ErrorAction.Shutdown, handled: true }), closed: () => ({ action: CloseAction.DoNotRestart, handled: true }) },
        middleware,
      });
      session.client = client;
      session.documents = new LanguageDocuments((method, params) => client.sendNotification(method, params),
        uri => vscode.workspace.textDocuments.find(document => document.uri.toString() === uri && !document.isClosed));
      session.edits = new LanguageEdits(client, context, this.support, () => this.accepts(revision, signal), this.log, () => this.modelRevision);
      Object.assign(middleware, session.edits.middleware());
      const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(vscode.Uri.file(context.root), "bsl-analyzer.toml"));
      session.configurationWatcher = watcher;
      /** Observe managed-config changes without replacing the metadata session or parsing TOML in the editor. */
      const changed = (uri: vscode.Uri): void => {
        if (uri.scheme !== "file" || this.session !== session || !this.current(revision, signal)) return;
        this.invalidateModel(); this.holdConfiguration(); this.scheduleConfigurationCheck();
      };
      watcher.onDidCreate(changed); watcher.onDidChange(changed); watcher.onDidDelete(changed);
      for (const source of context.sources) {
        if (state.session.projects.some(project => nativePath(project.sourcePath) === source.source)) continue;
        session.observers.push(watchSourceFiles(source.source, path => {
          if (this.session === session && this.current(revision, signal)) this.sourceChanged(path);
        }));
        const manifest = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(vscode.Uri.file(source.root), "eska.toml"));
        session.observers.push(manifest);
        manifest.onDidCreate(changed); manifest.onDidChange(changed); manifest.onDidDelete(changed);
      }
      this.protectSources(context.sources.filter(source => !state.session.projects.some(project => nativePath(project.rootPath) === source.root))
        .map(source => source.root));
      if (!this.current(revision, signal)) return;
      await client.start();
      if (!this.current(revision, signal)) return;
      if (client.initializeResult?.serverInfo?.name !== "bsl-analyzer" || client.initializeResult.serverInfo.version !== ANALYZER_VERSION) throw new ToolFailure("incompatible", "lsp-server-info");
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
      const version = document.version, model = this.modelRevision, documents = this.session?.documents, languageEpoch = documents?.epoch;
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
        const document = typeof uri === "string" ? vscode.workspace.textDocuments.find(value => value.uri.toString() === uri) : undefined;
        const version = document?.version;
        const documents = this.session?.documents, internal = this.queryLanguage?.owns(params);
        const languageEpoch = documents?.epoch;
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
      provideHover: (doc, pos, token, next) => read(doc, token, () => next(doc, pos, token)),
      provideDefinition: (doc, pos, token, next) => read(doc, token, () => next(doc, pos, token)),
      provideTypeDefinition: (doc, pos, token, next) => read(doc, token, () => next(doc, pos, token)),
      provideReferences: (doc, pos, context, token, next) => read(doc, token, () => next(doc, pos, context, token)),
      provideDocumentSymbols: (doc, token, next) => read(doc, token, () => next(doc, token)),
      provideCompletionItem: (doc, pos, context, token, next) => read(doc, token, () => next(doc, pos, context, token)),
      provideSignatureHelp: (doc, pos, context, token, next) => read(doc, token, () => next(doc, pos, context, token)),
      provideDocumentSemanticTokens: (doc, token, next) => read(doc, token, () => next(doc, token)),
      handleDiagnostics: (uri, values, next) => {
        if (!this.current(revision, signal)) return;
        if (this.session?.documents?.poisoned(uri.toString())) return;
        if (this.configurationPending) {
          this.bufferDiagnostics(uri, () => next(uri, values), () => this.accepts(revision, signal));
        } else next(uri, values);
      },
    };
  }

  /** Stop obsolete upstream work immediately instead of waiting for its result merely to discard it. */
  private invalidateModel(): void {
    ++this.modelRevision;
    for (const request of this.reading) request.cancel();
    this.queryLanguage?.changed();
  }

  /** Release resources in lease order even if the protocol peer ignores its normal shutdown request. */
  private async cleanup(): Promise<void> {
    const session = this.session;
    if (!session) return;
    await this.queryLanguage?.detach();
    session.configurationWatcher?.dispose();
    session.progress?.dispose();
    for (const observer of session.observers) observer.dispose();
    await session.edits?.shutdown();
    try { await session.client?.stop(4000); } catch { this.log("language_shutdown_failed", "warn"); }
    await session.owner?.stop();
    await session.client?.dispose(1000).catch(() => this.log("language_client_dispose_failed", "warn"));
    if (this.connection.state === session.state) {
      await this.connection.analyzerRequest("analyzer/release", { leaseId: session.lease }).catch(error => this.log(`language_lease_release_failed ${String(error)}`, "warn"));
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
    this.log(JSON.stringify({ event: "language_failed", code, ...(error instanceof ExplorerError && error.code === "analyzerVersionMismatch"
      ? { backendAnalyzer: error.details?.backendAnalyzer, expectedAnalyzer: error.details?.expectedAnalyzer } : {}) }), "error");
    if (this.refreshConflict()) { this.showConflictState(); return; }
    const detail = code === "analyzerVersionMismatch" ? this.text("analyzerVersionMismatch")
      : code === "migration_required" ? this.text("languageMigrationRequired") : code === "managed_conflict" ? this.text("languageManagedConflict") : this.text("languageFailed", code);
    this.tooling.analyzerState("error", detail);
    void vscode.window.showErrorMessage(detail);
  }

  /** Await owned cleanup before the extension's shared output channel is disposed. */
  async shutdown(): Promise<void> { this.dispose(); await this.stop(); }

  /** The synchronous hook invalidates late work immediately; shutdown owns the awaited teardown. */
  dispose(): void { if (!this.disposed) { this.disposed = true; ++this.revision; this.scope?.abort(); for (const value of this.subscriptions) value.dispose(); } }
}
