import { isAbsolute } from "node:path";
import { diagnostic, errorContext, type DiagnosticLog } from "./diagnostics.js";
import { BackendProcess, type ProcessOptions } from "./process.js";
import { API_VERSION, BASE_API_VERSION, QUERY_API_VERSION, RECOVERY_API_VERSION, SESSION_API_VERSION, LEGACY_API_VERSION, ExplorerError, isRecord, parseHandshake, parseWorkspace, type BackendKind, type WorkspaceSession } from "./protocol.js";
import { queryCapabilities, type QueryCapabilities } from "./query/protocol.js";
import { recoveryCapabilities, type RecoveryEndpoint } from "./query/recovery-protocol.js";
import { querySessionCapabilities } from "./query/session-protocol.js";
import { sourceCapabilities, type SourceEndpoint } from "./source-access.js";

export interface ConnectionTarget { executable: string; path: string; name: string; locale: "ru-RU" | "en-US"; backend?: BackendKind }
export type ConnectionState =
  | { kind: "disconnected" | "connecting" | "stopping" }
  | { kind: "ready"; session: WorkspaceSession; version: string; supportPolicy: boolean; supportFiles: boolean; supportObjects: boolean; sourceNavigation: boolean; analyzerConfiguration: boolean; queryEditing: QueryCapabilities | undefined; target: ConnectionTarget }
  | { kind: "error"; error: ExplorerError };

/** Own the lifecycle independently of VS Code so restarts can be tested with real pipes. */
export class Connection {
  private child: BackendProcess | undefined;
  private queue: Promise<void> = Promise.resolve();
  private revision = 0;
  private disposed = false;
  private current: ConnectionState = { kind: "disconnected" };
  private lastTarget: ConnectionTarget | undefined;
  private structuralRequest: Promise<unknown> | undefined;
  private readonly listeners = new Set<(method: string, params: unknown) => void>();
  private readonly sourceListeners = new Set<() => void>();
  private recoveryEndpoint: RecoveryEndpoint | undefined;
  private sourceEndpoint: SourceEndpoint | undefined;
  private sourceEra: object = {};
  private readonly recoveryListeners = new Set<(endpoint: RecoveryEndpoint | undefined) => void>();
  private readonly stopListeners = new Set<() => Promise<void>>();
  private stoppingChild: { child: BackendProcess; pending: Promise<void> } | undefined;

  constructor(
    private readonly version: string,
    private readonly changed: (state: ConnectionState) => void,
    private readonly log: DiagnosticLog,
    private readonly create: (options: ProcessOptions) => BackendProcess = (options) => new BackendProcess(options),
  ) {}

  /** Read immutable snapshots; failed or obsolete sessions are never exposed as ready. */
  get state(): ConnectionState { return this.current; }
  get target(): ConnectionTarget | undefined { return this.lastTarget; }
  get recovery(): RecoveryEndpoint | undefined { return this.recoveryEndpoint; }
  get sources(): SourceEndpoint | undefined { return this.sourceEndpoint; }
  get sourceRevision(): object { return this.sourceEra; }

  /** Recovery follows the initialized process, including a process whose metadata workspace failed to open. */
  onRecovery(listener: (endpoint: RecoveryEndpoint | undefined) => void): { dispose(): void } {
    this.recoveryListeners.add(listener);
    return { dispose: () => { this.recoveryListeners.delete(listener); } };
  }

  /** Checkpoint acknowledgements must finish before restart/disconnect can terminate their process. */
  beforeStop(listener: () => Promise<void>): { dispose(): void } {
    this.stopListeners.add(listener);
    return { dispose: () => { this.stopListeners.delete(listener); } };
  }

  /** A replaced session cannot publish responses into the replacement tree. */
  async request(sessionId: string, method: string, params: Record<string, unknown> = {}, signal?: AbortSignal): Promise<unknown> {
    while (this.structuralRequest) {
      try { await this.structuralRequest; } catch { /* Recheck the live session after a failed structural operation. */ }
      if (signal?.aborted) throw new ExplorerError("cancelled");
    }
    const child = this.sessionChild(sessionId);
    const sourceMutation = this.sourceMutation(method);
    const structural = ["metadata/renamePreview", "metadata/renameApply", "metadata/undoProperty"].includes(method)
      || (method === "metadata/updateProperty" && typeof params?.contextSnapshot === "string");
    // Backend scans cannot stop midway. Keep the barrier until their actual reply, even if a tab closes.
    const pending = child.request(method, { ...params, sessionId }, structural ? 600_000 : undefined, structural ? undefined : signal);
    if (structural) this.structuralRequest = pending;
    let result: unknown;
    try { result = await pending; }
    finally {
      if (this.structuralRequest === pending) this.structuralRequest = undefined;
      if (sourceMutation && this.child === child) for (const listener of this.sourceListeners) listener();
    }
    if (signal?.aborted) throw new ExplorerError("cancelled");
    if (child !== this.sessionChild(sessionId)) throw new ExplorerError("obsolete");
    return result;
  }

  /** The caller owns file sequence numbers; the connection owns session authority. */
  notify(sessionId: string, method: string, params: Record<string, unknown>): void {
    this.sessionChild(sessionId).notify(method, { ...params, sessionId });
  }

  /** Subscribe before opening a tree, and dispose with that tree's owner. */
  onNotification(listener: (method: string, params: unknown) => void): { dispose(): void } {
    this.listeners.add(listener);
    return { dispose: () => { this.listeners.delete(listener); } };
  }

  /** Protected native views refresh only after the backend has completed its source ownership change. */
  onSourceChange(listener: () => void): { dispose(): void } {
    this.sourceListeners.add(listener);
    return { dispose: () => { this.sourceListeners.delete(listener); } };
  }

  /** Analyzer RPCs use their own input schema and lease, without a metadata generation or injected sessionId. */
  async analyzerRequest(method: "analyzer/context" | "analyzer/configStatus" | "analyzer/configPrepare" | "analyzer/migrationPreview"
    | "analyzer/migrationApply" | "analyzer/acquire" | "analyzer/release", params: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
    const state = this.current;
    if (state.kind !== "ready" || !state.analyzerConfiguration) throw new ExplorerError("incompatible");
    const child = this.sessionChild(state.session.sessionId);
    const timeout = ["analyzer/configPrepare", "analyzer/migrationPreview", "analyzer/migrationApply"].includes(method) ? 190_000 : 30_000;
    const result = await child.request(method, params, timeout, signal);
    if (child !== this.sessionChild(state.session.sessionId)) throw new ExplorerError("obsolete");
    return result;
  }

  /** Validate both lifecycle state and session identity before any metadata operation. */
  private sessionChild(sessionId: string): BackendProcess {
    if (this.current.kind !== "ready" || this.current.session.sessionId !== sessionId || !this.child) {
      throw new ExplorerError("obsolete");
    }
    return this.child;
  }

  /** Serialize replacements while invalidating the old in-flight result immediately. */
  connect(target: ConnectionTarget): Promise<void> {
    if (this.disposed) return Promise.resolve();
    const revision = ++this.revision;
    this.lastTarget = target;
    diagnostic(this.log, "connection_connect", { clientVersion: this.version, executable: target.executable, cwd: target.path, locale: target.locale });
    this.recoveryEndpoint = undefined;
    this.sourceEndpoint = undefined;
    this.sourceEra = {};
    this.set({ kind: "connecting" });
    // Interrupt a slow open instead of waiting its full timeout before switching folders.
    void this.stopChild("restart").catch(() => this.log("process_cleanup_failed"));
    this.queue = this.queue.then(async () => {
      let negotiated = false;
      try {
        await this.stopChild();
        if (revision !== this.revision) return;
        const backend = target.backend ?? "project";
        if (!isAbsolute(target.path) || !target.executable.trim()
          || !["project", "legacy"].includes(backend)
          || (!isAbsolute(target.executable) && /[\\/]/.test(target.executable))
          || target.executable.includes("\0") || target.executable !== target.executable.trim()) {
          throw new ExplorerError("invalidExecutable");
        }
        const child = this.create({ executable: target.executable, cwd: target.path, log: this.log,
          args: backend === "legacy" ? ["ide", "--stdio"] : ["serve", "--stdio"],
          notification: (method, params) => {
            if (revision === this.revision) for (const listener of this.listeners) listener(method, params);
          },
          failed: (error) => {
            if (negotiated && revision === this.revision) {
              this.recoveryEndpoint = undefined;
              this.sourceEndpoint = undefined;
              this.sourceEra = {};
              this.set({ kind: "error", error });
            }
          },
        });
        this.child = child;
        const initialize = (apiVersion: { major: number; minor: number }): Promise<unknown> => child.request("initialize", {
          apiVersion, client: { name: "eska-explorer", version: this.version }, locale: target.locale, allowPropertyEdits: true,
        }, 10_000);
        let response: unknown;
        try { response = await initialize(backend === "legacy" ? LEGACY_API_VERSION : API_VERSION); }
        catch (error) {
          const supported = error instanceof ExplorerError ? error.details?.supported : undefined;
          if (backend !== "project" || !(error instanceof ExplorerError) || error.domain !== "unsupported_version"
            || !isRecord(supported) || supported.major !== 1
            || typeof supported.minor !== "number" || !Number.isInteger(supported.minor)
            || supported.minor < BASE_API_VERSION.minor || supported.minor >= API_VERSION.minor) throw error;
          response = await initialize(supported.minor >= 17 ? { major: 1, minor: supported.minor } : supported.minor === 16 ? SESSION_API_VERSION : supported.minor >= 14 ? RECOVERY_API_VERSION
            : supported.minor === QUERY_API_VERSION.minor ? QUERY_API_VERSION : BASE_API_VERSION);
        }
        const version = parseHandshake(response, backend);
        const queries = backend === "project" ? queryCapabilities(response) : undefined;
        const recovery = backend === "project" ? recoveryCapabilities(response) : undefined;
        const sessions = backend === "project" ? querySessionCapabilities(response) : undefined;
        const sources = backend === "project" ? sourceCapabilities(response) : undefined;
        negotiated = true;
        if (revision !== this.revision) return;
        const request = async (method: string, params: Record<string, unknown>): Promise<unknown> => {
          if (this.child !== child) throw new ExplorerError("obsolete");
          const sourceMutation = this.sourceMutation(method);
          // Metadata authority is deliberately absent; even a failed manifest can retain an inert draft.
          let result: unknown;
          try { result = await child.request(method, params); }
          finally { if (sourceMutation && this.child === child) for (const listener of this.sourceListeners) listener(); }
          if (this.child !== child) throw new ExplorerError("obsolete");
          return result;
        };
        if (sources) this.sourceEndpoint = { limits: sources, request };
        if (recovery) {
          const endpoint: RecoveryEndpoint = { capabilities: recovery, request,
            ...(sessions ? { sessions: { capabilities: sessions, request } } : {}) };
          this.recoveryEndpoint = endpoint;
          this.publishRecovery();
        }
        const session = parseWorkspace(await child.request("workspace/open", {
          start: { value: target.path, encoding: "utf-8" }, selection: { kind: "current" }, diskCache: true,
        }));
        if (revision === this.revision) {
          diagnostic(this.log, "connection_ready", { backendVersion: version, sessionId: session.sessionId,
            projects: session.projects.map((project) => ({ projectId: project.projectId, type: project.type,
              rootPath: project.rootPath, sourcePath: project.sourcePath, generation: project.generation })) });
          this.set({ kind: "ready", session, version, sourceNavigation: isRecord(response) && isRecord(response.capabilities) && response.capabilities.sourceNavigation === true,
            supportPolicy: isRecord(response) && isRecord(response.capabilities) && response.capabilities.supportPolicy === true,
            supportFiles: isRecord(response) && isRecord(response.capabilities) && response.capabilities.supportFiles === true,
            supportObjects: isRecord(response) && isRecord(response.capabilities) && response.capabilities.supportObjects === true,
            analyzerConfiguration: isRecord(response) && isRecord(response.capabilities) && response.capabilities.analyzerConfiguration === true,
            queryEditing: queries, target });
        }
      } catch (error) {
        if (!negotiated && error instanceof ExplorerError
          && ["connectionLost", "protocolInvalid"].includes(error.code)) {
          error = new ExplorerError("handshakeFailed");
        }
        const keepRecovery = negotiated && this.recoveryEndpoint && error instanceof ExplorerError
          && ["manifestMissing", "manifestInvalid", "selectionInvalid", "sourceInvalid", "rootInvalid"].includes(error.code);
        if (!keepRecovery) {
          this.recoveryEndpoint = undefined;
          this.sourceEndpoint = undefined;
          try { await this.stopChild(); }
          catch { error = new ExplorerError("cleanupFailed"); }
        }
        if (revision === this.revision) {
          this.set({ kind: "error", error: error instanceof ExplorerError ? error : new ExplorerError("spawnFailed") });
        }
      }
    });
    return this.queue;
  }

  /** Disconnect also invalidates pending connects and waits for the owned process to exit. */
  disconnect(): Promise<void> {
    const revision = ++this.revision;
    this.recoveryEndpoint = undefined;
    this.sourceEndpoint = undefined;
    this.sourceEra = {};
    this.set({ kind: "stopping" });
    void this.stopChild("disconnect").catch(() => this.log("process_cleanup_failed"));
    this.queue = this.queue.then(async () => {
      try {
        await this.stopChild();
        if (revision === this.revision) this.set({ kind: "disconnected" });
      } catch {
        if (revision === this.revision) this.set({ kind: "error", error: new ExplorerError("cleanupFailed") });
      }
    });
    return this.queue;
  }

  /** Deactivation awaits cleanup; no child is detached or unref'ed. */
  dispose(): Promise<void> { this.disposed = true; return this.disconnect(); }

  /** Native authorization snapshots expire before any queued request can change source ownership in this process. */
  private sourceMutation(method: string): boolean {
    if ((method.startsWith("query/session") && !["query/sessionGet", "query/sessionComments"].includes(method))
      || ["workspace/close", "query/recoveryOpen", "query/recoveryClose", "query/recoveryRemove"].includes(method)) {
      this.sourceEra = {};
      return true;
    }
    return false;
  }

  /** Retain the child reference if cleanup fails, preventing an overlapping replacement. */
  private async stopChild(reason?: string): Promise<void> {
    const child = this.child;
    if (!child) return;
    if (this.stoppingChild?.child === child) return this.stoppingChild.pending;
    const pending = (async () => {
      const results = await Promise.allSettled([...this.stopListeners].map(listener => listener()));
      await child.stop(reason);
      if (this.child === child) this.child = undefined;
      for (const result of results) if (result.status === "rejected") throw result.reason;
    })();
    this.stoppingChild = { child, pending };
    try { await pending; }
    finally { if (this.stoppingChild?.pending === pending) this.stoppingChild = undefined; }
  }

  /** Publish one state transition to the adapter. */
  private set(state: ConnectionState): void {
    if (state.kind === "error" && this.current.kind === "error" && state.error.code === this.current.error.code) return;
    diagnostic(this.log, "connection_state", { state: state.kind, ...(state.kind === "error" ? errorContext(state.error) : {}) });
    this.current = state;
    this.changed(state);
    this.publishRecovery();
  }

  /** A capability may arrive before the metadata tree or remain available alongside its error. */
  private publishRecovery(): void { for (const listener of this.recoveryListeners) listener(this.recoveryEndpoint); }
}
