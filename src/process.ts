import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { FrameReader, frame } from "./framing.js";
import { ExplorerError, isRecord, responseError } from "./protocol.js";

interface Pending {
  resolve: (value: unknown) => void;
  reject: (error: ExplorerError) => void;
  timer: NodeJS.Timeout;
}
export interface ProcessOptions {
  executable: string;
  cwd: string;
  args?: string[];
  timeoutMs?: number;
  log: (message: string) => void;
  failed: (error: ExplorerError) => void;
  notification?: (method: string, params: unknown) => void;
}

/** Own one child and its pipes; every terminal condition settles all outstanding requests. */
export class BackendProcess {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly reader = new FrameReader();
  private readonly pending = new Map<string, Pending>();
  private readonly closed: Promise<void>;
  private ended = false;
  private failure: ExplorerError | undefined;
  private stopping = false;
  private stopPromise: Promise<void> | undefined;
  private serial = 0n;
  private logBytes = 0;

  constructor(private readonly options: ProcessOptions) {
    this.child = spawn(options.executable, options.args ?? ["ide", "--stdio"], {
      cwd: options.cwd, shell: false, windowsHide: true, stdio: "pipe",
    });
    this.closed = new Promise((resolve) => {
      this.child.once("close", (code, signal) => {
        this.ended = true;
        options.log(`process_closed code=${code ?? "null"} signal=${signal ?? "none"}`);
        this.fail(new ExplorerError("connectionLost"));
        resolve();
      });
    });
    this.child.on("error", (error: NodeJS.ErrnoException) => {
      options.log(`spawn_error code=${error.code ?? "unknown"}`);
      this.fail(new ExplorerError(error.code === "ENOENT" ? "executableMissing" : "spawnFailed"));
    });
    this.child.stdin.on("error", () => this.fail(new ExplorerError("connectionLost")));
    this.child.stdout.on("error", () => this.fail(new ExplorerError("connectionLost")));
    this.child.stderr.on("error", () => this.fail(new ExplorerError("connectionLost")));
    this.child.stdout.on("data", (chunk: Buffer) => {
      if (this.failure) return;
      try { this.reader.push(chunk, (value) => this.receive(value)); }
      catch { this.fail(new ExplorerError("protocolInvalid")); }
    });
    this.child.stdout.on("end", () => {
      try { this.reader.finish(); }
      catch { this.fail(new ExplorerError("protocolInvalid")); }
    });
    this.child.stderr.on("data", (chunk: Buffer) => {
      // Continue draining after the cap; noisy or incompatible programs cannot fill the log.
      const remaining = 16_384 - this.logBytes;
      if (remaining > 0) {
        const text = chunk.subarray(0, remaining).toString("utf8")
          .replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "");
        options.log(`stderr: ${text}`);
        this.logBytes += Math.min(remaining, chunk.length);
      }
    });
  }

  /** Useful for lifecycle tests and diagnostics, never for killing by process name. */
  get pid(): number | undefined { return this.child.pid; }

  /** Notifications share the ordered, bounded transport with requests. */
  notify(method: string, params: unknown): void { this.write({ jsonrpc: "2.0", method, params }); }

  /** Unique string IDs avoid precision loss and accidental reuse after cancellation. */
  request(method: string, params: unknown, timeoutMs = this.options.timeoutMs ?? 30_000): Promise<unknown> {
    if (this.failure || this.ended) return Promise.reject(this.failure ?? new ExplorerError("connectionLost"));
    if (this.pending.size >= 64) return Promise.reject(new ExplorerError("resourceLimit"));
    const id = String(++this.serial);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => this.fail(new ExplorerError("timeout")), timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try { this.write({ jsonrpc: "2.0", id, method, params }); }
      catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error);
      }
    });
  }

  /** Serialize whole frames in one stream write, with a bounded outgoing queue. */
  private write(value: unknown): void {
    if (this.failure || this.ended) throw this.failure ?? new ExplorerError("connectionLost");
    const bytes = frame(value);
    if (this.child.stdin.writableLength + bytes.length > 4_194_304) throw new ExplorerError("resourceLimit");
    this.child.stdin.write(bytes);
  }

  /** Notifications are not responses; a foreign or duplicate response is a broken connection. */
  private receive(value: unknown): void {
    if (!isRecord(value) || value.jsonrpc !== "2.0") throw new ExplorerError("protocolInvalid");
    if (typeof value.method === "string" && !("id" in value)) {
      this.options.notification?.(value.method, value.params);
      return;
    }
    if (typeof value.id !== "string" || ("result" in value) === ("error" in value)) {
      throw new ExplorerError("protocolInvalid");
    }
    const pending = this.pending.get(value.id);
    if (!pending) throw new ExplorerError("protocolInvalid");
    if ("error" in value && (!isRecord(value.error) || !Number.isInteger(value.error.code)
      || typeof value.error.message !== "string")) throw new ExplorerError("protocolInvalid");
    this.pending.delete(value.id);
    clearTimeout(pending.timer);
    if (isRecord(value.error)) {
      this.options.log(`request_error code=${String(value.error.code)}`);
      pending.reject(responseError(value.error));
    } else pending.resolve(value.result);
  }

  /** First failure wins, including races between pipe errors and process exit. */
  private fail(error: ExplorerError): void {
    if (this.failure) return;
    this.failure = error;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
    if (!this.stopping) {
      this.options.failed(error);
      // Stop immediately on protocol failure, then reap even a SIGTERM-resistant peer.
      void this.stop().catch(() => this.options.log("process_cleanup_failed"));
    }
  }

  /** A bounded wait always clears its timer, avoiding timer leaks on normal shutdown. */
  private waitForClose(milliseconds: number): Promise<boolean> {
    if (this.ended) return Promise.resolve(true);
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve(false), milliseconds);
      void this.closed.then(() => { clearTimeout(timer); resolve(true); });
    });
  }

  /** Idempotent shutdown; a replacement child must wait until this promise succeeds. */
  stop(): Promise<void> {
    this.stopPromise ??= this.finish();
    return this.stopPromise;
  }

  /** Ask for protocol shutdown, then terminate only this owned process on deadline. */
  private async finish(): Promise<void> {
    this.stopping = true;
    if (this.ended) return;
    if (!this.failure) {
      try {
        await this.request("shutdown", {}, 1000);
        this.write({ jsonrpc: "2.0", method: "exit" });
        // Keep stdin open until exit is processed: early EOF aborts queued requests in eska.
        if (await this.waitForClose(1000)) return;
      } catch { /* A failed handshake still has to release its child. */ }
    }
    this.child.kill("SIGTERM");
    if (await this.waitForClose(500)) return;
    this.child.kill("SIGKILL");
    if (!(await this.waitForClose(2000))) throw new ExplorerError("cleanupFailed");
  }
}
