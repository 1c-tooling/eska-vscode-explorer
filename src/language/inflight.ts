import type { CancellationToken, CancellationTokenSource } from "vscode";

interface Pending {
  source: CancellationTokenSource;
  clients: Set<symbol>;
  reply: Promise<unknown>;
  pending: boolean;
  shared: boolean;
}

/** Share only identical concurrent protocol reads; completed answers never survive a request. */
export class InFlightReads {
  private readonly requests = new Map<string, Pending>();

  /** The owning client supplies its editor cancellation primitives. */
  constructor(private readonly source: () => CancellationTokenSource, private readonly cancelled: () => Error) {}

  /** A caller cancels its own subscription; the upstream request stops when its final subscriber cancels. */
  read<T>(key: string, token: CancellationToken, execute: (token: CancellationToken) => Promise<T>): Promise<T> {
    if (token.isCancellationRequested) return Promise.reject(this.cancelled());
    let request = this.requests.get(key);
    if (!request) {
      const source = this.source();
      request = { source, clients: new Set(), reply: Promise.resolve(), pending: true, shared: false };
      const created = request;
      created.reply = Promise.resolve().then(() => execute(source.token)).finally(() => {
        created.pending = false;
        if (this.requests.get(key) === created) this.requests.delete(key);
        source.dispose();
      });
      this.requests.set(key, created);
    } else request.shared = true;
    const group = request, identity = Symbol();
    group.clients.add(identity);
    return new Promise<T>((resolve, reject) => {
      let done = false;
      let subscription: { dispose(): void } | undefined;
      /** Retire this subscriber before cancellation can synchronously notify any remaining listeners. */
      const finish = (result: { value: T } | { error: unknown }): void => {
        if (done) return;
        done = true;
        subscription?.dispose();
        group.clients.delete(identity);
        if (group.pending && group.clients.size === 0) {
          if (this.requests.get(key) === group) this.requests.delete(key);
          group.source.cancel();
        }
        if ("error" in result) reject(result.error); else resolve(result.value);
      };
      subscription = token.onCancellationRequested(() => finish({ error: this.cancelled() }));
      group.reply.then(value => {
        if (done) return;
        // Protocol values are JSON. Separate copies keep client converters from sharing mutable response objects.
        try { finish({ value: (group.shared ? structuredClone(value) : value) as T }); }
        catch (error) { finish({ error }); }
      }, error => finish({ error }));
      if (token.isCancellationRequested) finish({ error: this.cancelled() });
    });
  }
}
