import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { FrameReader, frame } from "./framing.js";
import { ExplorerError, isRecord, responseError } from "./protocol.js";
import { diagnostic, errorContext, requestContext, serverErrorContext, type DiagnosticLog } from "./diagnostics.js";

interface Pending {
  resolve: (value: unknown) => void;
  reject: (error: ExplorerError) => void;
  timer: NodeJS.Timeout;
  method: string;
  started: number;
  context: Record<string, unknown>;
}
export interface ProcessOptions {
  executable: string;
  cwd: string;
  args?: string[];
  timeoutMs?: number;
  log: DiagnosticLog;
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
  private stderrTail: Buffer = Buffer.alloc(0);
  private receivedBytes = 0;
  private lastOutput = performance.now();
  private stopReason = "none";

  constructor(private readonly options: ProcessOptions) {
    this.child = spawn(options.executable, options.args ?? ["ide", "--stdio"], {
      cwd: options.cwd, shell: false, windowsHide: true, stdio: "pipe",
    });
    this.log("process_start", { executable: options.executable, cwd: options.cwd, args: options.args ?? ["ide", "--stdio"] });
    this.closed = new Promise((resolve) => {
      this.child.once("close", (code, signal) => {
        this.ended = true;
        this.log("process_closed", { exitCode: code, signal, stopReason: this.stopReason,
          failure: this.failure?.code, receivedBytes: this.receivedBytes, stderrBytes: this.logBytes });
        if (this.logBytes > 16384) this.log("stderr_tail", { text: this.stderrTail.toString("utf8"), truncated: true });
        if (!this.stopping || this.pending.size) this.fail(new ExplorerError("connectionLost"));
        resolve();
      });
    });
    this.child.on("error", (error: NodeJS.ErrnoException) => {
      this.log("spawn_error", { code: error.code ?? "unknown", syscall: error.syscall });
      this.fail(new ExplorerError(error.code === "ENOENT" ? "executableMissing" : "spawnFailed"));
    });
    for (const [name, stream] of [["stdin", this.child.stdin], ["stdout", this.child.stdout], ["stderr", this.child.stderr]] as const) {
      stream.on("error", (error: NodeJS.ErrnoException) => {
        this.log("pipe_error", { stream: name, code: error.code ?? "unknown", syscall: error.syscall });
        this.fail(new ExplorerError("connectionLost"));
      });
    }
    this.child.stdout.on("data", (chunk: Buffer) => {
      if (this.failure) return;
      this.receivedBytes += chunk.length;
      this.lastOutput = performance.now();
      try { this.reader.push(chunk, (value) => this.receive(value)); }
      catch (error) {
        this.log("protocol_error", { ...errorContext(error), frame: this.reader.progress });
        this.fail(new ExplorerError("protocolInvalid"));
      }
    });
    this.child.stdout.on("end", () => {
      try { this.reader.finish(); }
      catch (error) {
        this.log("stdout_truncated", { ...errorContext(error), frame: this.reader.progress });
        this.fail(new ExplorerError("protocolInvalid"));
      }
    });
    this.child.stderr.on("data", (chunk: Buffer) => {
      // Keep a rolling tail even after the live cap: a late panic must not disappear from diagnostics.
      this.stderrTail = Buffer.concat([this.stderrTail, chunk.subarray(-16384)]).subarray(-16384);
      const remaining = 16384 - this.logBytes;
      if (remaining > 0) this.log("stderr", { text: chunk.subarray(0, remaining).toString("utf8") });
      this.logBytes += chunk.length;
      if (remaining > 0 && this.logBytes > 16384) this.log("stderr_live_limit", { retainedTailBytes: 16384 });
    });
  }

  /** Correlate every event with the owned process; JSON encoding prevents multiline log injection. */
  private log(event: string, fields: Record<string, unknown> = {}): void {
    diagnostic(this.options.log, event, { pid: this.child.pid ?? null, ...fields });
  }

  /** Useful for lifecycle tests and diagnostics, never for killing by process name. */
  get pid(): number | undefined { return this.child.pid; }

  /** Notifications share the ordered, bounded transport with requests. */
  notify(method: string, params: unknown): void {
    this.write({ jsonrpc: "2.0", method, params });
    this.log("notification_sent", { method, ...requestContext(params) });
  }

  /** Unique string IDs avoid precision loss and accidental reuse after cancellation. */
  request(method: string, params: unknown, timeoutMs = this.options.timeoutMs ?? 30_000): Promise<unknown> {
    if (this.failure || this.ended) return Promise.reject(this.failure ?? new ExplorerError("connectionLost"));
    if (this.pending.size >= 64) return Promise.reject(new ExplorerError("resourceLimit"));
    const id = String(++this.serial);
    return new Promise((resolve, reject) => {
      const started = performance.now();
      const context = requestContext(params);
      const timer = setTimeout(() => {
        this.log("request_timeout", { id, method, elapsedMs: Math.round(performance.now() - started), timeoutMs, ...context,
          sinceLastOutputMs: Math.round(performance.now() - this.lastOutput), frame: this.reader.progress });
        this.fail(new ExplorerError("timeout"));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer, method, started, context });
      try {
        this.write({ jsonrpc: "2.0", id, method, params });
        this.log("request_sent", { id, method, timeoutMs, pending: this.pending.size,
          queuedBytes: this.child.stdin.writableLength, ...context });
      }
      catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        this.log("request_write_error", { id, method, ...context, ...errorContext(error) });
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
    if (!isRecord(value) || value.jsonrpc !== "2.0") throw new ExplorerError("protocolInvalid", "invalid_envelope");
    if (typeof value.method === "string" && !("id" in value)) {
      this.log("notification_received", { method: value.method, ...requestContext(value.params) });
      this.options.notification?.(value.method, value.params);
      return;
    }
    if (typeof value.id !== "string" || ("result" in value) === ("error" in value)) {
      throw new ExplorerError("protocolInvalid", "invalid_response");
    }
    const pending = this.pending.get(value.id);
    if (!pending) throw new ExplorerError("protocolInvalid", "unknown_response_id");
    if ("error" in value && (!isRecord(value.error) || !Number.isInteger(value.error.code)
      || typeof value.error.message !== "string")) throw new ExplorerError("protocolInvalid", "invalid_error");
    this.pending.delete(value.id);
    clearTimeout(pending.timer);
    if (isRecord(value.error)) {
      this.log("request_error", { id: value.id, method: pending.method, elapsedMs: Math.round(performance.now() - pending.started),
        request: pending.context, ...serverErrorContext(value.error) });
      pending.reject(responseError(value.error));
    } else {
      this.log("request_completed", { id: value.id, method: pending.method, elapsedMs: Math.round(performance.now() - pending.started),
        ...requestContext(value.result), pending: this.pending.size });
      pending.resolve(value.result);
    }
  }

  /** First failure wins, including races between pipe errors and process exit. */
  private fail(error: ExplorerError): void {
    if (this.failure) return;
    this.failure = error;
    this.log(this.stopping ? "requests_interrupted" : "connection_failure", { ...errorContext(error), stopping: this.stopping, stopReason: this.stopReason,
      pending: [...this.pending].map(([id, pending]) => ({ id, method: pending.method,
        elapsedMs: Math.round(performance.now() - pending.started), ...pending.context })) });
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
    if (!this.stopping) {
      this.options.failed(error);
      // Stop immediately on protocol failure, then reap even a SIGTERM-resistant peer.
      void this.stop(error.code).catch(() => this.log("process_cleanup_failed"));
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
  stop(reason = "requested"): Promise<void> {
    if (!this.stopPromise) {
      this.stopReason = reason;
      this.log("process_stop_requested", { reason });
      this.stopPromise = this.finish();
    }
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
    this.log("process_signal", { signal: "SIGTERM", reason: this.stopReason });
    this.child.kill("SIGTERM");
    if (await this.waitForClose(500)) return;
    this.log("process_signal", { signal: "SIGKILL", reason: this.stopReason });
    this.child.kill("SIGKILL");
    if (!(await this.waitForClose(2000))) throw new ExplorerError("cleanupFailed");
  }
}
