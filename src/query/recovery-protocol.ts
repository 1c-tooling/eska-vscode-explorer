import type { FormatEndpoint } from "../formatting/protocol.js";
import { isRecord } from "../protocol.js";
import { invalid, isSnapshot, unsigned } from "./protocol.js";
import { isToken } from "../protocol.js";
import type { QuerySessionTransport } from "./session-protocol.js";

export const RECOVERY_LIMITS = {
  maxRecords: 16, maxRetainedBytes: 33_554_432, maxMetadataBytes: 1_048_576,
  maxTextBytes: 8_388_608, maxChunkBytes: 131_072, maxUploads: 1,
} as const;
export type RecoveryCapabilities = { readonly [K in keyof typeof RECOVERY_LIMITS]: number };
export type RecoveryMethod = "query/recoveryOpen" | "query/recoveryRead" | "query/recoveryBegin" | "query/recoveryAppend"
  | "query/recoveryCommit" | "query/recoveryCancel" | "query/recoveryRemove" | "query/recoveryClose" | "query/recoveryPreparedRead";
export interface RecoveryEndpoint {
  readonly capabilities: RecoveryCapabilities;
  readonly sessions?: QuerySessionTransport;
  readonly formatting?: FormatEndpoint;
  request(method: RecoveryMethod, params: Record<string, unknown>): Promise<unknown>;
}
export const RECOVERY_PARTS = ["metadata", "ownerText", "base", "draft"] as const;
export type RecoveryPart = typeof RECOVERY_PARTS[number];
export interface RecoveryDescription { bytes: number; snapshot: string }
export interface RecoveryHeader {
  id: string;
  revision: string;
  metadata: Record<string, unknown>;
  parts: Record<RecoveryPart, RecoveryDescription>;
  prepared?: PreparedRecoveryHeader;
}
export interface PreparedRecoveryHeader {
  applyToken: string;
  format: "editor" | "source";
  saveOwner: boolean;
  noOp: boolean;
  parts: Record<"output" | "appliedDraft", RecoveryDescription>;
}
export const RECOVERY_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** Older backends retain tree/LSP access; private recovery requires the common API explicitly. */
export function recoveryCapabilities(hello: unknown): RecoveryCapabilities | undefined {
  if (!isRecord(hello) || !isRecord(hello.capabilities) || hello.capabilities.queryRecovery === undefined) return undefined;
  const value = hello.capabilities.queryRecovery;
  if (!isRecord(hello.apiVersion) || hello.apiVersion.major !== 1 || !unsigned(hello.apiVersion.minor)
    || hello.apiVersion.minor < 14 || !isRecord(value) || value.schemaVersion !== 1 || value.storageVersion !== 1
    || value.writesOwner !== false || value.compareRevision !== true || value.maxUploads !== 1) invalid();
  const limits = { ...RECOVERY_LIMITS };
  for (const key of Object.keys(RECOVERY_LIMITS) as (keyof typeof RECOVERY_LIMITS)[]) {
    if (!unsigned(value[key]) || value[key] === 0) invalid();
    Object.assign(limits, { [key]: Math.min(value[key], RECOVERY_LIMITS[key]) });
  }
  return limits;
}

/** Bounds apply before allocating any component advertised by an untrusted backend response. */
export function recoveryHeader(value: unknown, limits: RecoveryCapabilities): RecoveryHeader {
  if (!isRecord(value) || !isRecoveryId(value.id) || !isSnapshot(value.revision)
    || !isRecord(value.metadata) || value.metadata.id !== value.id || !isRecord(value.parts)
    || Object.keys(value.parts).length !== RECOVERY_PARTS.length) invalid();
  for (const part of RECOVERY_PARTS) {
    const description = value.parts[part];
    if (!isRecord(description) || !unsigned(description.bytes)
      || description.bytes > (part === "metadata" ? limits.maxMetadataBytes : limits.maxTextBytes)
      || !isSnapshot(description.snapshot)) invalid();
  }
  if (value.prepared !== undefined) {
    const prepared = value.prepared;
    if (!isRecord(prepared) || !isToken(prepared.applyToken) || prepared.applyToken === "0"
      || !["editor", "source"].includes(String(prepared.format)) || typeof prepared.saveOwner !== "boolean"
      || typeof prepared.noOp !== "boolean" || (prepared.noOp && prepared.saveOwner) || !isRecord(prepared.parts)
      || Object.keys(prepared.parts).length !== 2) invalid();
    for (const part of ["output", "appliedDraft"] as const) {
      const description = prepared.parts[part];
      if (!isRecord(description) || !unsigned(description.bytes) || description.bytes > limits.maxTextBytes
        || !isSnapshot(description.snapshot)) invalid();
    }
  }
  return value as unknown as RecoveryHeader;
}

/** Canonical identifiers cannot turn a late save into a different checkpoint or a filesystem path. */
export function isRecoveryId(value: unknown): value is string { return typeof value === "string" && RECOVERY_ID.test(value); }
