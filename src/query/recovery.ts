import { mkdir, readdir, rename, rm, lstat, writeFile } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { ExplorerError, isRecord, isToken, isWirePath, type WirePath } from "../protocol.js";
import { isNodeId, type NodeId } from "../tree.js";
import { querySnapshot } from "./client.js";
import { isQueryIdentity, isSnapshot, QUERY_LIMITS, type QueryIdentity } from "./protocol.js";

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

const MAX_RECORD_BYTES = 64 * 1024 * 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const RECORD_FIELDS = ["schemaVersion", "id", "projectKey", "node", "source", "descriptor", "descriptorSnapshot",
  "diskSnapshot", "ownerSnapshot", "ownerText", "ownerVersion", "contextFingerprint", "application", "identity", "base", "draft", "writable"];

/** Validate private recovery data as untrusted input before it can identify any project source. */
export function parseDraftRecord(value: unknown): QueryDraftRecord {
  if (!isRecord(value) || Object.keys(value).length !== RECORD_FIELDS.length || Object.keys(value).some(key => !RECORD_FIELDS.includes(key))
    || value.schemaVersion !== 1 || typeof value.id !== "string" || !UUID.test(value.id)
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

/** One private store retains the latest acknowledged draft without ever writing project sources. */
export class QueryRecovery {
  private readonly values = new Map<string, QueryDraftRecord>();
  private readonly pending = new Map<string, QueryDraftRecord>();
  private readonly writing = new Map<string, Promise<void>>();
  private readonly removed = new Set<string>();
  private readonly loaded: Promise<void>;

  constructor(private readonly directory: string, private readonly damaged: (id: string) => void) {
    this.loaded = this.load();
  }

  /** Recovered records require explicit session resumption; loading never applies source edits. */
  async records(): Promise<readonly QueryDraftRecord[]> {
    await this.loaded;
    return [...this.values.values()];
  }

  /** Replace pending content rather than building an unbounded queue while the filesystem is slow. */
  async save(record: QueryDraftRecord): Promise<void> {
    await this.loaded;
    if (!UUID.test(record.id) || this.removed.has(record.id)) throw new ExplorerError("obsolete");
    const previous = this.values.get(record.id);
    const used = [...this.values.values()].reduce((sum, value) => sum + retainedBytes(value), 0);
    if ((!previous && this.values.size >= QUERY_LIMITS.maxDocuments)
      || used - (previous ? retainedBytes(previous) : 0) + retainedBytes(record) > QUERY_LIMITS.maxRetainedBytes) {
      throw new ExplorerError("resourceLimit");
    }
    // The caller publishes immutable records. Only loading needs to rehash the unchanged complete owner.
    if (![record.ownerText, record.base, record.draft].every(boundedText) || !boundedMetadata(record)) throw new ExplorerError("resourceLimit");
    this.values.set(record.id, record);
    this.pending.set(record.id, record);
    let job = this.writing.get(record.id);
    if (!job) {
      job = this.flush(record.id);
      this.writing.set(record.id, job);
      void job.finally(() => { if (this.writing.get(record.id) === job) this.writing.delete(record.id); }).catch(() => {});
    }
    await job;
  }

  /** A discarded/closed session cannot resurrect its draft through an earlier pending write. */
  async remove(id: string): Promise<void> {
    if (!UUID.test(id)) throw new ExplorerError("sourceChanged");
    await this.loaded;
    this.removed.add(id);
    this.values.delete(id);
    this.pending.delete(id);
    try { await this.writing.get(id); }
    finally { await rm(join(this.directory, `${id}.json`), { force: true }); }
  }

  /** Deactivation awaits actual storage operations instead of cancelling an unacknowledged draft. */
  async settled(): Promise<void> {
    await this.loaded;
    await Promise.all(this.writing.values());
  }

  /** Inspect only this store's named regular records; malformed data stays available for manual recovery. */
  private async load(): Promise<void> {
    let names: string[];
    try { names = await readdir(this.directory); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
    let bytes = 0;
    for (const name of names.sort()) {
      if (!name.endsWith(".json") || !UUID.test(name.slice(0, -5))) continue;
      const id = name.slice(0, -5);
      try {
        const path = join(this.directory, name);
        const stat = await lstat(path);
        if (!stat.isFile() || stat.size > MAX_RECORD_BYTES) throw new ExplorerError("sourceChanged");
        const chunks: Buffer[] = [];
        let size = 0;
        for await (const chunk of createReadStream(path, { start: 0, end: MAX_RECORD_BYTES })) {
          const bytes = chunk as Buffer;
          size += bytes.length;
          if (size > MAX_RECORD_BYTES) throw new ExplorerError("resourceLimit");
          chunks.push(bytes);
        }
        const text = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks));
        const value = storedRecord(JSON.parse(text));
        if (value.id !== id || this.values.size >= QUERY_LIMITS.maxDocuments
          || bytes + retainedBytes(value) > QUERY_LIMITS.maxRetainedBytes) throw new ExplorerError("resourceLimit");
        this.values.set(id, value);
        bytes += retainedBytes(value);
      } catch { this.damaged(id); }
    }
  }

  /** Atomic replacement keeps the previous complete record if a write or rename fails. */
  private async flush(id: string): Promise<void> {
    await mkdir(this.directory, { recursive: true });
    while (this.pending.has(id) && !this.removed.has(id)) {
      const record = this.pending.get(id)!;
      this.pending.delete(id);
      // Base64 bounds UTF-8 recovery overhead even for unfinished drafts full of JSON control characters.
      const text = JSON.stringify({ ...record, storageVersion: 1,
        ownerText: Buffer.from(record.ownerText).toString("base64"), base: Buffer.from(record.base).toString("base64"),
        draft: Buffer.from(record.draft).toString("base64") });
      if (Buffer.byteLength(text) > MAX_RECORD_BYTES) throw new ExplorerError("resourceLimit");
      const temporary = join(this.directory, `${id}.${randomUUID()}.tmp`);
      try {
        await writeFile(temporary, text, { flag: "wx", mode: 0o600 });
        if (!this.removed.has(id)) await rename(temporary, join(this.directory, `${id}.json`));
      } finally { await rm(temporary, { force: true }); }
    }
  }
}

/** Each logical text has the same bounded UTF-8 contract as the backend's snapshots. */
function boundedText(value: unknown): value is string {
  return typeof value === "string" && Buffer.byteLength(value) <= QUERY_LIMITS.maxSnapshotBytes
    && Buffer.from(value).toString("utf8") === value;
}

/** Storage counts the owner and both draft revisions, independently of JSON escaping overhead. */
function retainedBytes(record: QueryDraftRecord): number {
  return Buffer.byteLength(record.ownerText) + Buffer.byteLength(record.base) + Buffer.byteLength(record.draft);
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

/** Decode only this private format; JSON escaping cannot bypass the logical UTF-8 quotas. */
function storedRecord(value: unknown): QueryDraftRecord {
  if (!isRecord(value) || value.storageVersion !== 1 || Object.keys(value).length !== RECORD_FIELDS.length + 1
    || Object.keys(value).some(key => key !== "storageVersion" && !RECORD_FIELDS.includes(key))) throw new ExplorerError("sourceChanged");
  const decoded = { ...value };
  delete decoded.storageVersion;
  for (const key of ["ownerText", "base", "draft"]) {
    const text = value[key];
    if (typeof text !== "string" || text.length > 4 * Math.ceil(QUERY_LIMITS.maxSnapshotBytes / 3)) throw new ExplorerError("sourceChanged");
    const bytes = Buffer.from(text, "base64");
    if (bytes.length > QUERY_LIMITS.maxSnapshotBytes || bytes.toString("base64") !== text) throw new ExplorerError("sourceChanged");
    decoded[key] = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  }
  return parseDraftRecord(decoded);
}
