import { BackendProcess } from "../process.js";
import { API_VERSION, ExplorerError, isRecord } from "../protocol.js";
import type { DiagnosticLog } from "../diagnostics.js";
import { formatCapabilities, type FormatEndpoint } from "./protocol.js";

interface Entry { key: string; child: BackendProcess; ready: Promise<FormatEndpoint> }

/** A text-only server initializes no metadata workspace and starts no analyzer. */
export class FormattingBackend {
  private entry: Entry | undefined;
  private disposed = false;
  private readonly closing = new Set<Promise<void>>();

  constructor(private readonly version: string, private readonly log: DiagnosticLog) {}

  /** Concurrent requests share their exact process; a different folder/configuration expires the old endpoint. */
  async endpoint(executable: string, cwd: string, locale: "ru-RU" | "en-US"): Promise<FormatEndpoint> {
    if (this.disposed) throw new ExplorerError("obsolete");
    const key = JSON.stringify([executable, cwd, locale]);
    if (this.entry?.key === key) return this.entry.ready;
    await this.stop();
    if (this.disposed) throw new ExplorerError("obsolete");
    if (this.entry) return this.endpoint(executable, cwd, locale);
    const child = new BackendProcess({ executable, cwd, log: this.log, failed: () => {
      if (this.entry?.child === child) this.entry = undefined;
      void this.reap(child).catch(() => {});
    } });
    const entry: Entry = { key, child, ready: Promise.resolve(undefined as never) };
    this.entry = entry;
    entry.ready = (async () => {
      try {
        const hello = await child.request("initialize", { apiVersion: API_VERSION, client: { name: "eska-explorer", version: this.version }, locale }, 10_000);
        const limits = formatCapabilities(hello);
        if (!limits || !isRecord(hello) || !isRecord(hello.server) || hello.server.name !== "eska-project"
          || typeof hello.server.version !== "string" || !hello.server.version) throw new ExplorerError("incompatible");
        return { limits, request: async (method, params, signal) => {
          if (this.disposed || this.entry !== entry) throw new ExplorerError("obsolete");
          const result = await child.request(method, params, 35_000, signal);
          if (this.disposed || this.entry !== entry) throw new ExplorerError("obsolete");
          return result;
        } } satisfies FormatEndpoint;
      } catch (error) { if (this.entry === entry) this.entry = undefined; await this.reap(child); throw error; }
    })();
    return entry.ready;
  }

  /** Shutdown reaps only the process created for formatting, independent of tree/language sessions. */
  async stop(): Promise<void> {
    const entry = this.entry; this.entry = undefined;
    if (entry) await this.reap(entry.child);
    await Promise.all([...this.closing]);
  }

  /** Even a failed pipe retains an awaited cleanup owner until its exact child has exited. */
  private async reap(child: BackendProcess): Promise<void> {
    const pending = child.stop(); this.closing.add(pending);
    try { await pending; } finally { this.closing.delete(pending); }
  }

  /** Deactivation waits for process cleanup before unloading the host. */
  async shutdown(): Promise<void> { this.disposed = true; await this.stop(); }
}
