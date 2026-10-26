import { createHash } from "node:crypto";
import { ExplorerError, isRecord } from "../protocol.js";
import { invalid } from "./protocol.js";

export type QueryBufferMethod = "query/bufferBegin" | "query/bufferAppend" | "query/bufferClose";
export type QueryTextInput = { text: string } | { bufferId: string };

/** Hash exactly the submitted UTF-8 text, including retained BOM and physical line endings. */
export function querySnapshot(text: string): string { return createHash("sha256").update(text, "utf8").digest("hex"); }

/** Reuse the bounded upload contract for native owners and full constructor buffers. */
export async function withQueryText<T>(text: string, limits: { maxSnapshotBytes: number; maxInlineBytes: number },
  request: (method: QueryBufferMethod, params: Record<string, unknown>) => Promise<unknown>,
  release: (id: string) => Promise<void>, use: (input: QueryTextInput) => Promise<T>, signal?: AbortSignal): Promise<T> {
  assertActive(signal);
  const bytes = Buffer.from(text, "utf8");
  if (bytes.toString("utf8") !== text) throw new ExplorerError("sourceChanged");
  if (bytes.length > limits.maxSnapshotBytes) throw new ExplorerError("resourceLimit");
  if (bytes.length <= limits.maxInlineBytes) return use({ text });
  let bufferId: string | undefined;
  try {
    const begun = await request("query/bufferBegin", { bytes: bytes.length, snapshot: querySnapshot(text) });
    if (isRecord(begun) && typeof begun.bufferId === "string" && begun.bufferId) bufferId = begun.bufferId;
    if (!bufferId || !isRecord(begun) || begun.receivedBytes !== 0 || begun.ready !== false) invalid();
    for (let offset = 0; offset < bytes.length;) {
      assertActive(signal);
      let end = Math.min(offset + limits.maxInlineBytes, bytes.length);
      while (end < bytes.length && (bytes[end]! & 0xc0) === 0x80) end--;
      if (end === offset) throw new ExplorerError("resourceLimit");
      const value = await request("query/bufferAppend", { bufferId, offset, text: bytes.toString("utf8", offset, end) });
      if (!isRecord(value) || value.bufferId !== bufferId || value.receivedBytes !== end || value.ready !== (end === bytes.length)) invalid();
      offset = end;
    }
    assertActive(signal);
    return await use({ bufferId });
  } finally { if (bufferId) await release(bufferId); }
}

/** Allocation acknowledgements must be retained before caller cancellation can trigger cleanup. */
function assertActive(signal?: AbortSignal): void { if (signal?.aborted) throw new ExplorerError("cancelled"); }
