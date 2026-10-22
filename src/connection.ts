import { isAbsolute } from "node:path";
import { diagnostic, errorContext, type DiagnosticLog } from "./diagnostics.js";
import { BackendProcess, type ProcessOptions } from "./process.js";
import { API_VERSION, LEGACY_API_VERSION, ExplorerError, isRecord, parseHandshake, parseWorkspace, type BackendKind, type WorkspaceSession } from "./protocol.js";

export interface ConnectionTarget { executable: string; path: string; name: string; locale: "ru-RU" | "en-US"; backend?: BackendKind }
export type ConnectionState =
  | { kind: "disconnected" | "connecting" | "stopping" }
  | { kind: "ready"; session: WorkspaceSession; version: string; supportPolicy: boolean; supportFiles: boolean; analyzerConfiguration: boolean; target: ConnectionTarget }
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

  constructor(
    private readonly version: string,
    private readonly changed: (state: ConnectionState) => void,
    private readonly log: DiagnosticLog,
    private readonly create: (options: ProcessOptions) => BackendProcess = (options) => new BackendProcess(options),
  ) {}

  /** Read immutable snapshots; failed or obsolete sessions are never exposed as ready. */
  get state(): ConnectionState { return this.current; }
  get target(): ConnectionTarget | undefined { return this.lastTarget; }

  /** A replaced session cannot publish responses into the replacement tree. */
  async request(sessionId: string, method: string, params: Record<string, unknown> = {}, signal?: AbortSignal): Promise<unknown> {
    while (this.structuralRequest) {
      try { await this.structuralRequest; } catch { /* Recheck the live session after a failed structural operation. */ }
      if (signal?.aborted) throw new ExplorerError("cancelled");
    }
    const child = this.sessionChild(sessionId);
    const structural = ["metadata/renamePreview", "metadata/renameApply", "metadata/undoProperty"].includes(method)
      || (method === "metadata/updateProperty" && typeof params?.contextSnapshot === "string");
    // Backend scans cannot stop midway. Keep the barrier until their actual reply, even if a tab closes.
    const pending = child.request(method, { ...params, sessionId }, structural ? 600_000 : undefined, structural ? undefined : signal);
    if (structural) this.structuralRequest = pending;
    let result: unknown;
    try { result = await pending; }
    finally { if (this.structuralRequest === pending) this.structuralRequest = undefined; }
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
    this.set({ kind: "connecting" });
    // Interrupt a slow open instead of waiting its full timeout before switching folders.
    void this.child?.stop("restart").catch(() => this.log("process_cleanup_failed"));
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
            if (negotiated && revision === this.revision) this.set({ kind: "error", error });
          },
        });
        this.child = child;
        const response = await child.request("initialize", {
          apiVersion: backend === "legacy" ? LEGACY_API_VERSION : API_VERSION, client: { name: "eska-explorer", version: this.version }, locale: target.locale, allowPropertyEdits: true,
        }, 10_000);
        const version = parseHandshake(response, backend);
        negotiated = true;
        if (revision !== this.revision) return;
        const session = parseWorkspace(await child.request("workspace/open", {
          start: { value: target.path, encoding: "utf-8" }, selection: { kind: "current" }, diskCache: true,
        }));
        if (revision === this.revision) {
          diagnostic(this.log, "connection_ready", { backendVersion: version, sessionId: session.sessionId,
            projects: session.projects.map((project) => ({ projectId: project.projectId, type: project.type,
              rootPath: project.rootPath, sourcePath: project.sourcePath, generation: project.generation })) });
          this.set({ kind: "ready", session, version, supportPolicy: isRecord(response) && isRecord(response.capabilities) && response.capabilities.supportPolicy === true,
            supportFiles: isRecord(response) && isRecord(response.capabilities) && response.capabilities.supportFiles === true,
            analyzerConfiguration: isRecord(response) && isRecord(response.capabilities) && response.capabilities.analyzerConfiguration === true, target });
        }
      } catch (error) {
        if (!negotiated && error instanceof ExplorerError
          && ["connectionLost", "protocolInvalid"].includes(error.code)) {
          error = new ExplorerError("handshakeFailed");
        }
        try { await this.stopChild(); }
        catch { error = new ExplorerError("cleanupFailed"); }
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
    this.set({ kind: "stopping" });
    void this.child?.stop("disconnect").catch(() => this.log("process_cleanup_failed"));
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

  /** Retain the child reference if cleanup fails, preventing an overlapping replacement. */
  private async stopChild(): Promise<void> {
    await this.child?.stop();
    this.child = undefined;
  }

  /** Publish one state transition to the adapter. */
  private set(state: ConnectionState): void {
    if (state.kind === "error" && this.current.kind === "error" && state.error.code === this.current.error.code) return;
    diagnostic(this.log, "connection_state", { state: state.kind, ...(state.kind === "error" ? errorContext(state.error) : {}) });
    this.current = state;
    this.changed(state);
  }
}
