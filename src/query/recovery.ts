import { isDeepStrictEqual } from "node:util";
import { ExplorerError, isRecord, isToken, isWirePath, type WirePath } from "../protocol.js";
import { isNodeId, type NodeId } from "../tree.js";
import { querySnapshot } from "./client.js";
import { invalid, isQueryIdentity, isSnapshot, QUERY_LIMITS, unsigned, type QueryIdentity } from "./protocol.js";
import { isRecoveryId, recoveryHeader, RECOVERY_PARTS, type RecoveryEndpoint, type RecoveryHeader,
  type RecoveryMethod, type RecoveryPart } from "./recovery-protocol.js";

export interface QueryDraftRecord {
  schemaVersion: 1;
  id: string;
  projectKey: string;
  node: NodeId;
  source: WirePath;
  descriptor: WirePath;
  descriptorSnapshot: string;
  diskSnapshot: string;
  ownerSnapshot: string;
  ownerText: string;
  ownerVersion: string;
  contextFingerprint: string;
  application: string | null;
  identity: QueryIdentity;
  base: string;
  draft: string;
  writable: boolean;
}

const RECORD_FIELDS = ["schemaVersion", "id", "projectKey", "node", "source", "descriptor", "descriptorSnapshot",
  "diskSnapshot", "ownerSnapshot", "ownerText", "ownerVersion", "contextFingerprint", "application", "identity", "base", "draft", "writable"];

/** Validate private recovery data as untrusted input before it can identify any project source. */
export function parseDraftRecord(value: unknown): QueryDraftRecord {
  if (!isRecord(value) || Object.keys(value).length !== RECORD_FIELDS.length || Object.keys(value).some(key => !RECORD_FIELDS.includes(key))
    || value.schemaVersion !== 1 || !isRecoveryId(value.id)
    || typeof value.projectKey !== "string" || !value.projectKey || !isNodeId(value.node)
    || !isWirePath(value.source) || !isWirePath(value.descriptor) || !isSnapshot(value.descriptorSnapshot)
    || !isSnapshot(value.diskSnapshot) || !isSnapshot(value.ownerSnapshot) || !isSnapshot(value.contextFingerprint)
    || !isToken(value.ownerVersion) || value.ownerVersion === "0" || typeof value.writable !== "boolean"
    || !(value.application === null || (typeof value.application === "string" && value.application.length > 0))
    || !boundedText(value.ownerText) || !boundedText(value.base) || !boundedText(value.draft)
    || !isQueryIdentity(value.identity, Buffer.byteLength(value.ownerText))
    || value.ownerSnapshot !== querySnapshot(value.ownerText) || !boundedMetadata(value)) throw new ExplorerError("sourceChanged");
  return value as unknown as QueryDraftRecord;
}

interface Entry {
  value: QueryDraftRecord;
  revision: string | null;
  header?: RecoveryHeader;
  pending?: QueryDraftRecord;
  closing: boolean;
  conflict: boolean;
}

/** Thin bounded transport: ESKA owns validation, quotas, compare-revision and atomic storage. */
export class QueryRecovery {
  private readonly values = new Map<string, Entry>();
  private readonly writing = new Map<string, Promise<void>>();
  private readonly removing = new Map<string, Promise<void>>();
  private readonly operations = new Set<Promise<unknown>>();
  private queue: Promise<void> = Promise.resolve();
  private readonly loaded: Promise<void>;
  private storeId: string | undefined;
  private closed = false;

  constructor(private readonly endpoint: RecoveryEndpoint, private readonly directory: string,
    private readonly damaged: (id: string) => void, previous: ReadonlyMap<string, string> = new Map()) {
    this.loaded = this.load(previous);
    void this.loaded.catch(() => {});
  }

  /** Recovered bindings remain inert until the owner is explicitly checked and resumed. */
  async records(): Promise<readonly QueryDraftRecord[]> {
    await this.loaded;
    return [...this.values.values()].map(entry => entry.value);
  }

  /** Native input may replace only the draft; source binding and baseline come from ESKA replies. */
  async saveDraft(id: string, draft: string): Promise<void> {
    await this.loaded;
    const entry = this.values.get(id);
    if (!entry) throw new ExplorerError("obsolete");
    await this.saveValue({ ...entry.value, draft });
  }

  /** UI caches can read the latest draft without manufacturing a new source binding. */
  record(id: string): QueryDraftRecord {
    const entry = this.values.get(id);
    if (!entry) throw new ExplorerError("obsolete");
    return entry.value;
  }

  /** An unfinished backend intent remains visible even when its source handle has been released. */
  hasPrepared(id: string): boolean { return this.values.get(id)?.header?.prepared !== undefined; }

  /** Source transitions share the upload queue and rebase pending native input onto acknowledged owner/base data. */
  async withCheckpoint<T extends { record: RecoveryHeader }>(id: string,
    action: (storeId: string, header: RecoveryHeader | undefined) => Promise<T>, create = false): Promise<T> {
    await this.loaded;
    this.active();
    return this.enqueue(async () => {
      this.active();
      const entry = this.values.get(id);
      if (create ? entry !== undefined : !entry || entry.closing) throw new ExplorerError("obsolete");
      if (create && this.values.size >= this.endpoint.capabilities.maxRecords) throw new ExplorerError("resourceLimit");
      if (entry?.conflict) throw new ExplorerError("sourceChanged");
      if (!this.storeId) throw new ExplorerError("obsolete");
      const result = await action(this.storeId, entry?.header);
      const header = recoveryHeader(result.record, this.endpoint.capabilities);
      if (header.id !== id) invalid();
      let retained = header.parts.ownerText.bytes + header.parts.base.bytes + header.parts.draft.bytes;
      for (const [otherId, other] of this.values) if (otherId !== id) {
        retained += Buffer.byteLength(other.value.ownerText) + Buffer.byteLength(other.value.base) + Buffer.byteLength(other.value.draft);
      }
      if (retained > this.endpoint.capabilities.maxRetainedBytes) throw new ExplorerError("resourceLimit");
      const record = await this.readRecord(header, entry?.value);
      if (entry) {
        const pending = entry.pending;
        entry.value = pending ? { ...record, draft: pending.draft } : record;
        if (pending) entry.pending = entry.value;
        entry.revision = header.revision;
        entry.header = header;
      } else this.values.set(id, { value: record, revision: header.revision, header, closing: false, conflict: false });
      return result;
    });
  }

  /** Carry acknowledged revisions across backend replacement without accepting another window's overwrite. */
  revisions(): ReadonlyMap<string, string> {
    return new Map([...this.values].flatMap(([id, entry]) => entry.revision ? [[id, entry.revision] as const] : []));
  }

  /** Creation is explicit; a late save of a closed or externally removed session cannot recreate it. */
  async create(record: QueryDraftRecord): Promise<void> {
    await this.loaded;
    this.active();
    parseDraftRecord(record);
    if (this.values.has(record.id)) throw new ExplorerError("obsolete");
    if (this.values.size >= this.endpoint.capabilities.maxRecords) throw new ExplorerError("resourceLimit");
    this.values.set(record.id, { value: record, revision: null, closing: false, conflict: false });
    await this.save(record);
  }

  /** Coalesce input while a single acknowledged upload uses the connection's staging slot. */
  async save(record: QueryDraftRecord): Promise<void> {
    await this.loaded;
    await this.saveValue(record);
  }

  /** Scheduling is synchronous after loading so a source acknowledgement cannot interleave between lookup and input. */
  private saveValue(record: QueryDraftRecord): Promise<void> {
    this.active();
    const entry = this.values.get(record.id);
    if (!entry || entry.closing) throw new ExplorerError("obsolete");
    if (entry.conflict) throw new ExplorerError("sourceChanged");
    entry.value = record;
    entry.pending = record;
    let job = this.writing.get(record.id);
    if (!job) {
      job = this.enqueue(() => this.flush(record.id, entry));
      this.writing.set(record.id, job);
    }
    return job;
  }

  /** A close drains its upload before removing only the exact last acknowledged checkpoint. */
  async remove(id: string, discardPrepared = false): Promise<void> {
    await this.loaded;
    this.active();
    if (!isRecoveryId(id)) throw new ExplorerError("sourceChanged");
    const previous = this.removing.get(id);
    if (previous) return previous;
    const entry = this.values.get(id);
    if (!entry) return;
    entry.closing = true;
    delete entry.pending;
    const job = this.enqueue(async () => {
      try {
        if (entry.revision) {
          const result = await this.request("query/recoveryRemove", { id, revision: entry.revision,
            ...(discardPrepared ? { discardPrepared: true } : {}) });
          if (typeof result.released !== "boolean") invalid();
        }
        this.values.delete(id);
      } finally { entry.closing = false; }
    });
    this.removing.set(id, job);
    try { await job; }
    finally { if (this.removing.get(id) === job) this.removing.delete(id); }
  }

  /** Teardown waits for actual RPC acknowledgements; cancellation does not stand in for persistence. */
  async settled(): Promise<void> {
    await this.loaded;
    let failure: unknown;
    while (this.operations.size) {
      for (const result of await Promise.allSettled([...this.operations])) if (result.status === "rejected") failure ??= result.reason;
    }
    if (failure) throw failure;
  }

  /** Closing retained backend memory keeps the private files available to a later process. */
  async close(): Promise<void> {
    await this.settled();
    if (this.closed) return;
    const result = await this.request("query/recoveryClose", {});
    if (result.released !== true) invalid();
    this.closed = true;
  }

  /** All writes share one staging slot; failed work does not prevent an unrelated record from being saved. */
  private enqueue<T>(action: () => Promise<T>): Promise<T> {
    const job = this.queue.then(action);
    this.queue = job.then(() => {}, () => {});
    this.operations.add(job);
    void job.finally(() => this.operations.delete(job)).catch(() => {});
    return job;
  }

  /** Backend headers and chunks are wire data, never an alternate source of write permission. */
  private async load(previous: ReadonlyMap<string, string>): Promise<void> {
    const result = await this.endpoint.request("query/recoveryOpen", { directory: { value: this.directory, encoding: "utf-8" } });
    if (!isRecord(result) || typeof result.storeId !== "string" || !result.storeId || !Array.isArray(result.records)
      || result.records.length > this.endpoint.capabilities.maxRecords || !Array.isArray(result.damaged)
      || result.damaged.length > 1024 || !result.damaged.every(isRecoveryId) || typeof result.limited !== "boolean") invalid();
    this.storeId = result.storeId;
    let bytes = 0;
    for (const value of result.records) {
      const header = recoveryHeader(value, this.endpoint.capabilities);
      if (this.values.has(header.id)) invalid();
      bytes += header.parts.ownerText.bytes + header.parts.base.bytes + header.parts.draft.bytes;
      if (bytes > this.endpoint.capabilities.maxRetainedBytes) invalid();
      const record = await this.readRecord(header);
      const expected = previous.get(header.id);
      this.values.set(record.id, { value: record, revision: expected ?? header.revision, header,
        closing: false, conflict: expected !== undefined && expected !== header.revision });
    }
    for (const id of result.damaged) this.damaged(id);
    if (result.limited) throw new ExplorerError("resourceLimit");
  }

  /** Reuse unchanged components only by the backend's exact byte count/hash, including the full metadata envelope. */
  private async readRecord(header: RecoveryHeader, previous?: QueryDraftRecord): Promise<QueryDraftRecord> {
    const part = async (name: RecoveryPart): Promise<string> => {
      const old = previous && (name === "metadata" ? JSON.stringify(this.metadata(previous)) : previous[name]);
      const description = header.parts[name];
      return old !== undefined && Buffer.byteLength(old) === description.bytes && querySnapshot(old) === description.snapshot
        ? old : this.read(header, name);
    };
    const metadata = JSON.parse(await part("metadata")) as unknown;
    if (!isRecord(metadata) || !isDeepStrictEqual(metadata, header.metadata)) invalid();
    return parseDraftRecord({ ...metadata, ownerText: await part("ownerText"), base: await part("base"), draft: await part("draft") });
  }

  /** Binding serialization is transport validation, independent from source syntax or ownership decisions. */
  private metadata(record: QueryDraftRecord): Record<string, unknown> {
    const { ownerText: _owner, base: _base, draft: _draft, ...metadata } = record;
    return metadata;
  }

  /** A chunk must advance on a UTF-8 boundary and identify the same immutable checkpoint revision. */
  private async read(header: RecoveryHeader, part: RecoveryPart): Promise<string> {
    const chunks: string[] = [];
    const description = header.parts[part];
    for (let offset = 0;;) {
      const value = await this.request("query/recoveryRead", { id: header.id, revision: header.revision, part, offset });
      if (value.id !== header.id || value.revision !== header.revision || value.part !== part || value.offset !== offset
        || typeof value.text !== "string" || !unsigned(value.nextOffset) || typeof value.complete !== "boolean") invalid();
      const bytes = Buffer.from(value.text);
      if (bytes.toString("utf8") !== value.text || bytes.length > this.endpoint.capabilities.maxChunkBytes
        || value.nextOffset !== offset + bytes.length || value.nextOffset > description.bytes
        || value.complete !== (value.nextOffset === description.bytes) || (!value.complete && !bytes.length)) invalid();
      chunks.push(value.text);
      if (value.complete) break;
      offset = value.nextOffset;
    }
    const text = chunks.join("");
    if (querySnapshot(text) !== description.snapshot) invalid();
    return text;
  }

  /** The latest immutable record replaces pending work without accumulating one upload per keystroke. */
  private async flush(id: string, entry: Entry): Promise<void> {
    try {
      while (entry.pending && !entry.closing) {
        const record = entry.pending;
        delete entry.pending;
        const header = await this.upload(record, entry.revision);
        entry.revision = header.revision;
        entry.header = header;
      }
    } catch (error) {
      delete entry.pending;
      if (!entry.revision && this.values.get(id) === entry) this.values.delete(id);
      throw error;
    } finally { this.writing.delete(id); }
  }

  /** ESKA can reuse unchanged owner/base components; only changed acknowledged bytes cross the pipe. */
  private async upload(record: QueryDraftRecord, expectedRevision: string | null): Promise<RecoveryHeader> {
    const { ownerText, base, draft, ...metadata } = record;
    const texts = { metadata: JSON.stringify(metadata), ownerText, base, draft };
    const parts = Object.fromEntries(RECOVERY_PARTS.map(part => {
      const text = texts[part];
      const bytes = Buffer.byteLength(text);
      if (bytes > (part === "metadata" ? this.endpoint.capabilities.maxMetadataBytes : this.endpoint.capabilities.maxTextBytes)
        || Buffer.from(text).toString("utf8") !== text) throw new ExplorerError("resourceLimit");
      return [part, { bytes, snapshot: querySnapshot(text) }];
    }));
    let updateId: string | undefined;
    try {
      const begun = await this.request("query/recoveryBegin", { id: record.id, expectedRevision, parts });
      if (typeof begun.updateId === "string" && begun.updateId) updateId = begun.updateId;
      if (!updateId || !isRecord(begun.received)) invalid();
      for (const part of RECOVERY_PARTS) {
        const bytes = Buffer.from(texts[part]);
        const received = begun.received[part];
        if (!unsigned(received) || (received !== 0 && received !== bytes.length)) invalid();
        for (let offset = received; offset < bytes.length;) {
          let end = Math.min(offset + this.endpoint.capabilities.maxChunkBytes, bytes.length);
          while (end < bytes.length && (bytes[end]! & 0xc0) === 0x80) end--;
          if (end === offset) throw new ExplorerError("resourceLimit");
          const value = await this.request("query/recoveryAppend", { updateId, part, offset, text: bytes.toString("utf8", offset, end) });
          if (value.updateId !== updateId || value.part !== part || value.receivedBytes !== end || value.ready !== (end === bytes.length)) invalid();
          offset = end;
        }
      }
      const result = recoveryHeader(await this.request("query/recoveryCommit", { updateId }), this.endpoint.capabilities);
      if (result.id !== record.id || !isDeepStrictEqual(result.metadata, metadata)
        || !["ownerText", "base", "draft"].every(part => isDeepStrictEqual(result.parts[part as RecoveryPart], parts[part]))) invalid();
      updateId = undefined;
      return result;
    } finally {
      if (updateId) {
        const result = await this.request("query/recoveryCancel", { updateId });
        if (typeof result.released !== "boolean") invalid();
      }
    }
  }

  /** Store handles cannot be borrowed by a new backend or a metadata session with a repeating ID. */
  private async request(method: RecoveryMethod, params: Record<string, unknown>): Promise<Record<string, unknown>> {
    this.active();
    if (!this.storeId) throw new ExplorerError("obsolete");
    const result = await this.endpoint.request(method, { ...params, storeId: this.storeId });
    if (!isRecord(result) || result.storeId !== this.storeId) invalid();
    return result;
  }

  /** No post-close mutation can implicitly reopen or recreate a checkpoint. */
  private active(): void { if (this.closed) throw new ExplorerError("obsolete"); }
}

/** Each logical text has the same bounded UTF-8 contract as the backend's snapshots. */
function boundedText(value: unknown): value is string {
  return typeof value === "string" && Buffer.byteLength(value) <= QUERY_LIMITS.maxSnapshotBytes
    && Buffer.from(value).toString("utf8") === value;
}

/** Private bindings keep the same frame-sized metadata envelope and reversible Unicode as the RPC client. */
function boundedMetadata(record: Record<string, unknown> | QueryDraftRecord): boolean {
  let reversible = true;
  const value = JSON.stringify({ ...record, ownerText: undefined, base: undefined, draft: undefined }, (_key, field: unknown) => {
    if (typeof field === "string" && Buffer.from(field).toString("utf8") !== field) reversible = false;
    return field;
  });
  return reversible && Buffer.byteLength(value) <= 1_048_576;
}
