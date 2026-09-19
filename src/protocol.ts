/** The public IDE API is versioned independently from the eska executable. */
export const API_VERSION = { major: 1, minor: 0 } as const;
export const MAX_HEADER = 8192;
export const MAX_REQUEST = 1_048_576;
export const MAX_RESPONSE = 67_108_864;

export type FailureCode =
  | "updateFailed" | "updateBusy" | "cliPathConflict"
  | "executableMissing" | "spawnFailed" | "connectionLost" | "protocolInvalid"
  | "handshakeFailed" | "timeout" | "resourceLimit" | "incompatible" | "manifestMissing"
  | "manifestInvalid" | "selectionInvalid" | "sourceInvalid" | "rootInvalid"
  | "requestFailed" | "cleanupFailed" | "unsupportedWorkspace" | "untrusted"
  | "noFolder" | "invalidExecutable" | "obsolete" | "branchInvalid" | "sourceMissing"
  | "unsupportedPath" | "sourceChanged" | "cancelled";

/** Only stable categories cross into the localized UI; raw protocol text stays private. */
export class ExplorerError extends Error {
  constructor(readonly code: FailureCode, readonly domain?: string) {
    super(code);
    this.name = "ExplorerError";
  }
}

export interface WirePath { value: string; encoding: "utf-8" | "percent" | "utf-16-percent" }
export interface ProjectInfo {
  projectId: string;
  scope: { kind: "standalone" } | { kind: "member"; name: string };
  type: "configuration" | "extension" | "processing" | "report";
  rootPath: WirePath;
  sourcePath: WirePath;
  root: { kind: "object"; objectId: string };
  generation: string;
  eventSequence: string;
  requiresRefresh: boolean;
  requiresReopen: boolean;
}
export interface WorkspaceSession { sessionId: string; projects: ProjectInfo[] }

/** Narrow untrusted JSON without treating arrays or null as records. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Reject incompatible peers before sending workspace paths. */
export function parseHandshake(value: unknown): string {
  if (!isRecord(value) || !isRecord(value.apiVersion) || !isRecord(value.server)
    || !isRecord(value.capabilities) || !isRecord(value.limits)) {
    throw new ExplorerError("protocolInvalid");
  }
  const { apiVersion, server, capabilities, limits } = value;
  if (apiVersion.major !== API_VERSION.major || !Number.isSafeInteger(apiVersion.minor)
    || (apiVersion.minor as number) < API_VERSION.minor || server.name !== "eska"
    || capabilities.designerXml !== true || capabilities.readOnly !== true
    || capabilities.multiContext !== false || capabilities.search !== true || capabilities.clientFileEvents !== true) {
    throw new ExplorerError("incompatible");
  }
  if (typeof server.version !== "string" || !server.version
    || limits.maxHeaderBytes !== MAX_HEADER || limits.maxRequestBytes !== MAX_REQUEST
    || limits.maxResponseBytes !== MAX_RESPONSE) {
    throw new ExplorerError("protocolInvalid");
  }
  return server.version;
}

/** Keep u64 tokens as strings; JavaScript numbers would round large generations. */
export function isToken(value: unknown): value is string {
  return typeof value === "string" && /^(0|[1-9][0-9]{0,19})$/.test(value)
    && BigInt(value) <= 18_446_744_073_709_551_615n;
}

/** Paths remain tagged until an operation actually needs a native path. */
export function isWirePath(value: unknown): value is WirePath {
  return isRecord(value) && typeof value.value === "string"
    && ["utf-8", "percent", "utf-16-percent"].includes(String(value.encoding));
}

/** Validate only fields used by this client, allowing future optional API fields. */
export function parseWorkspace(value: unknown): WorkspaceSession {
  if (!isRecord(value) || typeof value.sessionId !== "string" || !value.sessionId
    || !Array.isArray(value.projects) || value.projects.length === 0) {
    throw new ExplorerError("protocolInvalid");
  }
  const ids = new Set<string>();
  for (const project of value.projects) {
    if (!isRecord(project) || typeof project.projectId !== "string" || !project.projectId
      || ids.has(project.projectId) || !isRecord(project.scope)
      || !(project.scope.kind === "standalone" || (project.scope.kind === "member"
        && typeof project.scope.name === "string"))
      || !["configuration", "extension", "processing", "report"].includes(String(project.type))
      || !isWirePath(project.rootPath) || !isWirePath(project.sourcePath)
      || !isRecord(project.root) || project.root.kind !== "object"
      || typeof project.root.objectId !== "string" || !isToken(project.generation)
      || !isToken(project.eventSequence) || typeof project.requiresRefresh !== "boolean"
      || typeof project.requiresReopen !== "boolean") {
      throw new ExplorerError("protocolInvalid");
    }
    ids.add(project.projectId);
  }
  return value as unknown as WorkspaceSession;
}

/** Convert structured server errors, never localized stderr, into UI categories. */
export function responseError(value: Record<string, unknown>): ExplorerError {
  const data = value.data;
  if (value.code === -32601 || (isRecord(data) && data.kind === "unsupported_version")) {
    return new ExplorerError("incompatible");
  }
  if (isRecord(data) && data.kind === "project_open_failed" && isRecord(data.details)) {
    switch (data.details.reason) {
      case "manifest_missing": return new ExplorerError("manifestMissing");
      case "manifest_invalid": return new ExplorerError("manifestInvalid");
      case "selection_invalid": return new ExplorerError("selectionInvalid");
      case "source_invalid": return new ExplorerError("sourceInvalid");
      case "root_invalid": return new ExplorerError("rootInvalid");
    }
  }
  const kind = isRecord(data) && typeof data.kind === "string" ? data.kind : undefined;
  const code = kind === "cancelled" ? "cancelled"
    : kind === "source_missing" || kind === "unknown_node" || kind === "unknown_object" ? "sourceMissing"
    : kind === "xml_invalid" || kind === "source_invalid" ? "branchInvalid"
    : kind === "source_changed" ? "sourceChanged" : "requestFailed";
  return new ExplorerError(code, kind);
}
