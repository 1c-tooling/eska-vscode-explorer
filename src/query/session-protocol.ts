import { isRecord, isToken } from "../protocol.js";
import { invalid, unsigned, type QueryPlan } from "./protocol.js";
import { recoveryHeader, type RecoveryCapabilities, type RecoveryHeader } from "./recovery-protocol.js";

export interface QuerySessionCapabilities {
  readonly maxSessions: number;
  readonly maxRetainedBytes: number;
}
export type QuerySessionMethod = "query/sessionOpen" | "query/sessionRestore" | "query/sessionGet"
  | "query/sessionResume" | "query/sessionPrepare" | "query/sessionApplied" | "query/sessionAbort" | "query/sessionClose";
export interface QuerySessionTransport {
  readonly capabilities: QuerySessionCapabilities;
  request(method: QuerySessionMethod, params: Record<string, unknown>): Promise<unknown>;
}
export interface QueryOwnerFacts {
  version: string;
  snapshot: string;
  isDirty: boolean;
  userReadOnly: boolean;
  application: string | null;
}
export interface QuerySessionHeader {
  querySessionId: string;
  storeId: string;
  id: string;
  revision: string;
  resumed: boolean;
  applyPending: boolean;
  draftWritable: boolean;
  format: "editor" | "source";
  protection: { capturedSourceWritable: boolean; userReadOnly: boolean; ownerLock: string | null };
  record: RecoveryHeader;
}
export interface QuerySessionPlan extends QueryPlan {
  applyToken: string;
  saveOwner: boolean;
}
export interface QueryPreparedSession extends QuerySessionHeader { plan: QuerySessionPlan }

/** Native application requires the durable contract; an older memory-only capability is insufficient. */
export function querySessionCapabilities(hello: unknown): QuerySessionCapabilities | undefined {
  if (!isRecord(hello) || !isRecord(hello.capabilities) || !isRecord(hello.apiVersion)
    || !unsigned(hello.apiVersion.minor) || hello.apiVersion.minor < 16) return undefined;
  const value = hello.capabilities.querySessions;
  if (value === undefined) return undefined;
  if (hello.apiVersion.major !== 1 || !isRecord(value) || value.schemaVersion !== 1 || value.writesOwner !== false
    || value.checkpointStorageVersion !== 1 || value.preparedStorageVersion !== 2 || value.preparedStateDurable !== true
    || value.nativeApplicationReceipt !== true || value.explicitResume !== true || typeof value.bslEditing !== "boolean"
    || !Array.isArray(value.sourceKinds) || !value.sourceKinds.includes("dataCompositionSchema") || !value.sourceKinds.includes("form")
    || !unsigned(value.maxSessions) || value.maxSessions === 0 || !unsigned(value.maxRetainedBytes) || value.maxRetainedBytes === 0) invalid();
  return { maxSessions: Math.min(value.maxSessions, 16), maxRetainedBytes: Math.min(value.maxRetainedBytes, 33_554_432) };
}

/** Validate transport shape only; ESKA decides source ownership, permissions and lifecycle transitions. */
export function querySessionHeader(value: unknown, limits: RecoveryCapabilities): QuerySessionHeader {
  if (!isRecord(value) || typeof value.querySessionId !== "string" || !value.querySessionId
    || typeof value.storeId !== "string" || !value.storeId || !isToken(value.revision) || value.revision === "0"
    || typeof value.resumed !== "boolean" || typeof value.applyPending !== "boolean" || typeof value.draftWritable !== "boolean"
    || !["editor", "source"].includes(String(value.format)) || !isRecord(value.protection)
    || typeof value.protection.capturedSourceWritable !== "boolean" || typeof value.protection.userReadOnly !== "boolean"
    || !(value.protection.ownerLock === null || (isToken(value.protection.ownerLock) && value.protection.ownerLock !== "0"))) invalid();
  const record = recoveryHeader(value.record, limits);
  if (value.id !== record.id) invalid();
  return value as unknown as QuerySessionHeader;
}
