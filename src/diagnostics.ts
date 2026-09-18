import { ExplorerError, isRecord } from "./protocol.js";

export type DiagnosticLog = (line: string, level?: "info" | "warn" | "error") => void;
const failures = new Set(["request_timeout", "request_error", "connection_failure", "protocol_error", "stdout_truncated",
  "spawn_error", "pipe_error", "process_cleanup_failed", "request_write_error"]);
const warnings = new Set(["process_signal", "requests_interrupted", "stderr", "stderr_tail", "stderr_live_limit"]);

/** Keep one event per line and cap individual path/identity fields; source bodies are never selected. */
export function diagnostic(log: DiagnosticLog, event: string, fields: Record<string, unknown> = {}): void {
  const failed = failures.has(event) || (event === "connection_state" && fields.state === "error")
    || (event === "process_closed" && fields.stopReason === "none" && (fields.exitCode !== 0 || fields.signal !== null));
  log(JSON.stringify({ time: new Date().toISOString(), event, ...fields }), failed ? "error" : warnings.has(event) ? "warn" : "info");
}

/** Bounded wire identities remain useful without copying arbitrary request or response payloads. */
function scalar(value: unknown): string | number | boolean | undefined {
  if (typeof value === "string") return value.length > 512 ? `${value.slice(0, 512)}…` : value;
  if (typeof value === "number" || typeof value === "boolean") return value;
  return undefined;
}

/** Log only routing/operation fields, never XML properties, search text, BSL or whole protocol messages. */
export function requestContext(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) return {};
  const result: Record<string, unknown> = {};
  for (const key of ["id", "sessionId", "projectId", "generation", "eventSequence", "sequence", "objectId", "action", "manifestChanged", "resetFileSequence"]) {
    if (scalar(value[key]) !== undefined) result[key] = scalar(value[key]);
  }
  if (isRecord(value.node)) {
    result.node = {};
    for (const key of ["kind", "objectId", "owner", "role"]) {
      if (scalar(value.node[key]) !== undefined) (result.node as Record<string, unknown>)[key] = scalar(value.node[key]);
    }
    if (isRecord(value.node.collection)) (result.node as Record<string, unknown>).collection = {
      kind: scalar(value.node.collection.kind), metadataKind: scalar(value.node.collection.metadataKind),
    };
  }
  for (const key of ["start", "path"]) if (isRecord(value[key])) result[key] = {
    value: scalar(value[key].value), encoding: scalar(value[key].encoding),
  };
  if (Array.isArray(value.paths)) {
    result.pathCount = value.paths.length;
    result.pathSample = value.paths.slice(0, 5).map((path) => isRecord(path)
      ? { value: scalar(path.value), encoding: scalar(path.encoding) } : null);
  }
  return result;
}

/** Preserve structured categories without including exception messages that may embed source text. */
export function errorContext(error: unknown): Record<string, unknown> {
  if (error instanceof ExplorerError) return { code: error.code, kind: error.domain };
  return { name: error instanceof Error ? error.name : "unknown" };
}

/** Error details select only backend categories and source addresses, not arbitrary server messages. */
export function serverErrorContext(error: Record<string, unknown>): Record<string, unknown> {
  const data = isRecord(error.data) ? error.data : {};
  const details = isRecord(data.details) ? data.details : {};
  return { rpcCode: scalar(error.code), kind: scalar(data.kind), ...requestContext(data),
    details: { ...requestContext(details), reason: scalar(details.reason),
      expected: scalar(details.expected), actual: scalar(details.actual) } };
}
