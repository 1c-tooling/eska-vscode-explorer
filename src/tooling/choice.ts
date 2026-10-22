/** A dismissed or obsolete dialog cannot hold shutdown or apply a late action to another context. */
export async function cancellableChoice<T>(choice: PromiseLike<T>, signal: AbortSignal): Promise<T | undefined> {
  const pending = Promise.resolve(choice);
  if (signal.aborted) { void pending.catch(() => {}); return undefined; }
  let abort: (() => void) | undefined;
  try {
    return await Promise.race([pending, new Promise<undefined>(resolve => {
      abort = () => resolve(undefined);
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) abort();
    })]);
  } finally { if (abort) signal.removeEventListener("abort", abort); }
}
