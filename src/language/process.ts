import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import type { DiagnosticLog } from "../diagnostics.js";
import { ToolFailure, assertCurrent } from "../tooling/contracts.js";

/** Own exactly one published stdio server; the LSP client owns protocol shutdown, this owner guarantees reaping. */
export class LanguageProcess {
  readonly child: ChildProcessWithoutNullStreams;
  readonly closed: Promise<void>;
  private ended = false;
  private stopping: Promise<void> | undefined;
  private stderrBytes = 0;
  private readonly abort: () => void;

  constructor(executable: string, cwd: string, private readonly log: DiagnosticLog,
    failed: () => void, private readonly signal?: AbortSignal) {
    assertCurrent(signal);
    this.child = spawn(executable, ["lsp"], { cwd, shell: false, windowsHide: true, stdio: "pipe",
      env: { ...process.env, BSL_LOG: "warn" } });
    this.abort = () => { void this.stop().catch(() => this.log("language_process_cleanup_failed", "error")); };
    this.closed = new Promise(resolve => {
      this.child.once("close", (code, signal) => {
        this.ended = true; this.signal?.removeEventListener("abort", this.abort);
        this.log(JSON.stringify({ event: "language_process_closed", pid: this.child.pid, code, signal }));
        resolve();
        if (!this.stopping) failed();
      });
    });
    this.child.on("error", (error: NodeJS.ErrnoException) => {
      this.log(JSON.stringify({ event: "language_process_error", code: error.code }), "error");
    });
    // The client observes protocol-pipe errors; listeners also prevent an unhandled stream event during shutdown.
    for (const stream of [this.child.stdin, this.child.stdout, this.child.stderr]) stream.on("error", error => {
      this.log(JSON.stringify({ event: "language_pipe_error", code: (error as NodeJS.ErrnoException).code }), "warn");
    });
    this.child.stderr.on("data", (chunk: Buffer) => {
      const remaining = 16384 - this.stderrBytes;
      if (remaining > 0) this.log(chunk.subarray(0, remaining).toString("utf8"), "warn");
      this.stderrBytes += chunk.length;
    });
    this.log(JSON.stringify({ event: "language_process_start", pid: this.child.pid, executable, cwd, args: ["lsp"] }));
    signal?.addEventListener("abort", this.abort, { once: true });
    if (signal?.aborted) this.abort();
  }

  /** Wait briefly for normal LSP exit, then escalate signals only to the process created by this owner. */
  stop(): Promise<void> {
    this.stopping ??= this.finish();
    return this.stopping;
  }

  /** Never detach the child or let an unread stderr pipe prevent completion. */
  private async finish(): Promise<void> {
    if (await this.exitedWithin(1000)) return;
    this.child.kill("SIGTERM");
    if (await this.exitedWithin(1000)) return;
    this.child.kill("SIGKILL");
    if (!await this.exitedWithin(5000)) throw new ToolFailure("io", "language-process-cleanup");
  }

  /** Clear every deadline when the owned close event wins the race. */
  private async exitedWithin(milliseconds: number): Promise<boolean> {
    if (this.ended) return true;
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([this.closed.then(() => true), new Promise<false>(resolve => { timer = setTimeout(() => resolve(false), milliseconds); })]);
    } finally { clearTimeout(timer); }
  }
}
