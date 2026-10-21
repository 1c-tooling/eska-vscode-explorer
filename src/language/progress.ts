import type { Middleware } from "vscode-languageclient/node";

type ProgressHandler = NonNullable<Middleware["handleWorkDoneProgress"]>;
type Token = Parameters<ProgressHandler>[0];
type Pending = { value: Parameters<ProgressHandler>[1]; forward: Parameters<ProgressHandler>[2]; timer: NodeJS.Timeout };

/** Bound editor progress traffic while preserving the final value, lifecycle and cancellation of every token. */
export class LanguageProgress {
  private readonly pending = new Map<Token, Pending>();
  private disposed = false;

  /** A session generation decides whether a delayed presentation update is still relevant. */
  constructor(private readonly current: () => boolean) {}

  /** Large indexes report thousands of files; only intermediate presentation updates may be combined. */
  readonly handle: ProgressHandler = (token, value, forward) => {
    if (this.disposed || !this.current()) return;
    if (value.kind !== "report") {
      this.flush(token);
      forward(token, value);
      return;
    }
    const pending = this.pending.get(token);
    if (pending) { pending.value = value; pending.forward = forward; return; }
    this.pending.set(token, { value, forward, timer: setTimeout(() => this.flush(token), 100) });
  };

  /** End flushes the most recent report before closing progress; obsolete sessions never update the editor. */
  private flush(token: Token): void {
    const pending = this.pending.get(token);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pending.delete(token);
    if (this.current()) pending.forward(token, pending.value);
  }

  /** Session shutdown owns every timer even when the server stops without a progress-end notification. */
  dispose(): void {
    this.disposed = true;
    for (const pending of this.pending.values()) clearTimeout(pending.timer);
    this.pending.clear();
  }
}
