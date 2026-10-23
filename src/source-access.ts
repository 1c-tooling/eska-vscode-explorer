import { createHash } from "node:crypto";
import { ExplorerError, isRecord, isToken, isWirePath, type WirePath } from "./protocol.js";
import { nativePath } from "./source.js";

export interface SourceLimits {
  readonly maxSnapshotBytes: number; readonly maxSnapshots: number; readonly maxRetainedBytes: number;
  readonly maxChunkBytes: number; readonly maxPaths: number;
}
export type SourceMethod = "source/protection" | "source/snapshotOpen" | "source/snapshotRead" | "source/snapshotClose"
  | "source/bufferBegin" | "source/bufferAppend" | "source/bufferClose";
export interface SourceEndpoint { readonly limits: SourceLimits; request(method: SourceMethod, params: Record<string, unknown>): Promise<unknown> }
export interface SourceContext { sessionId: string; projectId: string; generation: string }
export interface SourceProtection {
  path: WirePath; objects: string[]; supportReadOnly: boolean; supportReason: string; supportUnknown: boolean; mixed: boolean;
  supportEnforced: boolean; userReadOnly: boolean; filesystemReadOnly: boolean; exists: boolean; writable: boolean;
  diagnostics: string[]; restrictions: { id: string; source: WirePath }[];
}
export interface NativeSourceSnapshot { version: string; text: string; userReadOnly: boolean }
export interface SourceView {
  snapshotId: string; path: WirePath; bytes: number; snapshot: string; origin: "disk" | "editor" | "querySession";
  version: string | null; protection: SourceProtection;
}

/** Only the negotiated immutable, binary-safe source contract can serve protected native views. */
export function sourceCapabilities(hello: unknown): SourceLimits | undefined {
  if (!isRecord(hello) || !isRecord(hello.capabilities) || !isRecord(hello.apiVersion)
    || hello.apiVersion.major !== 1 || !positive(hello.apiVersion.minor) || hello.apiVersion.minor < 17) return undefined;
  const value = hello.capabilities.sourceProtection;
  if (value === undefined) return undefined;
  if (!isRecord(value) || value.schemaVersion !== 1 || value.writesOwner !== false || value.sessionOwnerPriority !== true
    || value.binarySnapshots !== true || value.sharedQueryBudget !== true) invalid();
  const bounds = { maxSnapshotBytes: 8_388_608, maxSnapshots: 16, maxRetainedBytes: 33_554_432, maxChunkBytes: 131_072, maxPaths: 128 };
  return Object.fromEntries(Object.entries(bounds).map(([key, bound]) => {
    const limit = value[key]; if (!positive(limit)) invalid(); return [key, Math.min(limit, bound)];
  })) as unknown as SourceLimits;
}

/** Transport validation never reimplements the backend's support, ownership or writable decision. */
function protection(value: unknown): SourceProtection {
  if (!isRecord(value) || !isWirePath(value.path) || !Array.isArray(value.objects) || value.objects.some(id => typeof id !== "string")
    || typeof value.supportReason !== "string" || !Array.isArray(value.diagnostics) || value.diagnostics.some(item => typeof item !== "string")
    || !Array.isArray(value.restrictions) || value.restrictions.length > 16 || value.restrictions.some(owner => !isRecord(owner)
      || !isToken(owner.id) || owner.id === "0" || !isWirePath(owner.source))
    || ["supportReadOnly", "supportUnknown", "mixed", "supportEnforced", "userReadOnly", "filesystemReadOnly", "exists", "writable"]
      .some(key => typeof value[key] !== "boolean")) invalid();
  return value as unknown as SourceProtection;
}

/** Source handles and uploads belong to one initialized process and one exact metadata member. */
export class SourceAccess {
  constructor(private readonly endpoint: SourceEndpoint, private readonly context: () => SourceContext) {}

  /** ESKA alone evaluates the current support switch, temporary owners and adapter-reported user restriction. */
  async protection(files: { path: WirePath; userReadOnly: boolean }[], enforceSupport: boolean): Promise<SourceProtection[]> {
    if (!files.length || files.length > this.endpoint.limits.maxPaths) throw new ExplorerError("resourceLimit");
    const result = await this.request("source/protection", { files, enforceSupport }, this.context());
    if (!Array.isArray(result.files) || result.files.length !== files.length) invalid();
    return result.files.map((value, index) => {
      const state = protection(value);
      if (nativePath(state.path) !== nativePath(files[index]!.path)) invalid();
      return state;
    });
  }

  /** Read exact immutable bytes and release the source handle even when a later chunk is invalid. */
  async read(path: WirePath, native?: NativeSourceSnapshot): Promise<{ header: SourceView; bytes: Uint8Array }> {
    const context = this.context();
    let handle: string | undefined;
    try {
      const result = await this.withNative(native, context, async input => {
        const result = await this.request("source/snapshotOpen", { path, ...input }, context);
        if (typeof result.snapshotId === "string" && result.snapshotId) handle = result.snapshotId;
        return result;
      });
      if (!handle || !isWirePath(result.path) || nativePath(result.path) !== nativePath(path)
        || !nonnegative(result.bytes) || result.bytes > this.endpoint.limits.maxSnapshotBytes || !snapshot(result.snapshot)
        || !["disk", "editor", "querySession"].includes(String(result.origin))
        || !(result.version === null || (isToken(result.version) && result.version !== "0"))) invalid();
      const state = protection(result.protection);
      if (nativePath(state.path) !== nativePath(path)) invalid();
      const chunks: Buffer[] = [];
      let offset = 0;
      do {
        const part = await this.request("source/snapshotRead", { snapshotId: handle, snapshot: result.snapshot,
          offset, bytes: this.endpoint.limits.maxChunkBytes }, context, true);
        if (part.snapshotId !== handle || part.snapshot !== result.snapshot || part.offset !== offset || typeof part.data !== "string"
          || part.data.length > 4 * Math.ceil(this.endpoint.limits.maxChunkBytes / 3)
          || typeof part.complete !== "boolean" || !nonnegative(part.nextOffset)) invalid();
        const bytes = Buffer.from(part.data, "base64");
        if (bytes.toString("base64") !== part.data || bytes.length > this.endpoint.limits.maxChunkBytes
          || part.nextOffset !== offset + bytes.length || part.nextOffset > result.bytes || part.complete !== (part.nextOffset === result.bytes)
          || (!part.complete && !bytes.length)) invalid();
        chunks.push(bytes); offset = part.nextOffset;
      } while (offset < result.bytes);
      const bytes = Buffer.concat(chunks, result.bytes);
      if (digest(bytes) !== result.snapshot) invalid();
      return { header: { ...result, protection: state } as unknown as SourceView, bytes };
    } finally {
      if (handle) await this.release("source/snapshotClose", { snapshotId: handle }, context);
    }
  }

  /** Native input uses bounded UTF-8 chunks; binary source results never pass through a text decoder. */
  private async withNative<T>(native: NativeSourceSnapshot | undefined, context: SourceContext,
    use: (input: Record<string, unknown>) => Promise<T>): Promise<T> {
    if (!native) return use({});
    if (!isToken(native.version) || native.version === "0") invalid();
    const bytes = Buffer.from(native.text, "utf8");
    if (bytes.toString("utf8") !== native.text) throw new ExplorerError("sourceChanged");
    if (bytes.length > this.endpoint.limits.maxSnapshotBytes) throw new ExplorerError("resourceLimit");
    if (bytes.length <= this.endpoint.limits.maxChunkBytes) return use({ native });
    let bufferId: string | undefined;
    try {
      const begun = await this.request("source/bufferBegin", { bytes: bytes.length, snapshot: digest(bytes) }, context);
      if (typeof begun.bufferId === "string" && begun.bufferId) bufferId = begun.bufferId;
      if (!bufferId || begun.receivedBytes !== 0 || begun.ready !== false) invalid();
      for (let offset = 0; offset < bytes.length;) {
        let end = Math.min(offset + this.endpoint.limits.maxChunkBytes, bytes.length);
        while (end < bytes.length && (bytes[end]! & 0xc0) === 0x80) end--;
        if (end === offset) throw new ExplorerError("resourceLimit");
        const part = await this.request("source/bufferAppend", { bufferId, offset, text: bytes.toString("utf8", offset, end) }, context);
        if (part.bufferId !== bufferId || part.receivedBytes !== end || part.ready !== (end === bytes.length)) invalid();
        offset = end;
      }
      return await use({ native: { version: native.version, userReadOnly: native.userReadOnly, bufferId } });
    } finally { if (bufferId) await this.release("source/bufferClose", { bufferId }, context); }
  }

  /** Only immutable reads and exact cleanup omit the generation response envelope. */
  private async request(method: SourceMethod, params: Record<string, unknown>, context: SourceContext, cleanup = false): Promise<Record<string, unknown>> {
    const value = await this.endpoint.request(method, { ...context, ...params });
    if (!isRecord(value) || (!cleanup && (value.sessionId !== context.sessionId || value.projectId !== context.projectId
      || value.generation !== context.generation))) invalid();
    return value;
  }

  /** A stale metadata generation may release this process's own resource but never a replacement process's handle. */
  private async release(method: "source/snapshotClose" | "source/bufferClose", params: Record<string, unknown>, context: SourceContext): Promise<void> {
    const result = await this.request(method, params, context, true);
    if (typeof result.released !== "boolean") invalid();
  }
}

/** Safe integer bounds stop malformed allocation and chunk offsets before any native view is exposed. */
function nonnegative(value: unknown): value is number { return Number.isSafeInteger(value) && (value as number) >= 0; }
/** Negotiated resource limits must make progress and cannot be negative or fractional. */
function positive(value: unknown): value is number { return nonnegative(value) && value > 0; }
/** Exact byte hashes are independent of source language, locale, encoding and newline normalization. */
function digest(bytes: Uint8Array): string { return createHash("sha256").update(bytes).digest("hex"); }
/** Hash shape is validated independently from the captured body's later exact identity check. */
function snapshot(value: unknown): value is string { return typeof value === "string" && /^[0-9a-f]{64}$/.test(value); }
/** Malformed backend data must never be exposed as an editable/native source decision. */
function invalid(): never { throw new ExplorerError("protocolInvalid"); }
