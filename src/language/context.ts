import { isAbsolute, join, relative, sep } from "node:path";
import { ExplorerError, isRecord, isWirePath } from "../protocol.js";
import { nativePath } from "../source.js";

export interface LibraryReference { name: string; configuration: string }
export interface AnalysisSource { root: string; source: string; descriptor: string; member: string | null; projectType: "configuration" | "extension" | "processing" | "report"; library?: LibraryReference }
export interface AnalysisContext { root: string; name: string | null; limited: boolean; sources: AnalysisSource[] }
export type ConfigStatus = "current" | "missing" | "stale" | "migration_required" | "managed_conflict" | "context_conflict";
export interface AnalyzerConfiguration {
  path: string; status: ConfigStatus; token: string; context: string | null; fingerprint: string; body: string; lease?: string;
}

/** Only reversible absolute backend paths can become workspace roots or file watchers. */
function absolute(value: unknown): string {
  if (!isWirePath(value)) throw new ExplorerError("protocolInvalid");
  const path = nativePath(value);
  if (!isAbsolute(path)) throw new ExplorerError("protocolInvalid");
  return path;
}

/** Selection names are backend identities, never a second source/configuration parser. */
function name(value: unknown): string | null {
  if (value === null) return null;
  if (typeof value !== "string" || !value || value.includes("\0")) throw new ExplorerError("protocolInvalid");
  return value;
}

/** Catalog coordinates come from ESKA; the editor never resolves local names itself. */
function libraryReference(value: unknown): LibraryReference {
  if (!isRecord(value)) throw new ExplorerError("protocolInvalid");
  const selected = name(value.name);
  if (selected === null) throw new ExplorerError("protocolInvalid");
  return { name: selected, configuration: absolute(value.configuration) };
}

/** Parse only the versioned context DTO; topology, XML and manifest validation remain in eska-project. */
export function analysisContext(value: unknown): AnalysisContext {
  if (!isRecord(value) || value.schema_version !== 1 || value.kind !== "project-context" || value.status !== "ready"
    || !isRecord(value.context) || typeof value.context.limited_context !== "boolean" || !Array.isArray(value.context.sources)
    || !value.context.sources.length || value.context.sources.length > 8192) throw new ExplorerError("protocolInvalid");
  const context = value.context;
  const sources: AnalysisSource[] = (context.sources as unknown[]).map(item => {
    if (!isRecord(item) || !["configuration", "extension", "processing", "report"].includes(item.project_type as string)
      || !["configuration", "extension", "external_object"].includes(item.role as string)) throw new ExplorerError("protocolInvalid");
    const source = absolute(item.source);
    if (!isWirePath(item.descriptor)) throw new ExplorerError("protocolInvalid");
    const descriptor = nativePath(item.descriptor), local = relative(source, join(source, descriptor));
    if (!descriptor || isAbsolute(descriptor) || !local || local === ".." || local.startsWith(`..${sep}`)) throw new ExplorerError("protocolInvalid");
    const library = item.library === undefined ? undefined : libraryReference(item.library);
    if (library && (item.role !== "configuration" || item.project_type !== "configuration" || item.member !== null)) throw new ExplorerError("protocolInvalid");
    return { root: absolute(item.root), source, descriptor: join(source, descriptor), member: name(item.member), projectType: item.project_type as AnalysisSource["projectType"],
      ...(library ? { library } : {}) };
  });
  if (sources.filter(source => source.library !== undefined).length > 1) throw new ExplorerError("protocolInvalid");
  return { root: absolute(context.root), name: name(context.name), limited: context.limited_context as boolean, sources };
}

/** Bind an acquired lease to exactly the ordinary config and ownership hashes validated by the backend. */
export function analyzerConfiguration(value: unknown): AnalyzerConfiguration {
  if (!isRecord(value) || value.schema_version !== 1 || value.kind !== "analyzer-configuration"
    || !["current", "missing", "stale", "migration_required", "managed_conflict", "context_conflict"].includes(value.status as string)
    || !isRecord(value.ownership) || value.ownership.schema_version !== 1 || value.ownership.generator_version !== 1
    || typeof value.ownership.analyzer_version !== "string"
    || !/^\d+\.\d+\.\d+$/.test(value.ownership.analyzer_version)) throw new ExplorerError("protocolInvalid");
  const ownership = value.ownership;
  for (const hash of [value.preview_token, ownership.input_fingerprint, ownership.body_sha256]) {
    if (typeof hash !== "string" || !/^[0-9a-f]{64}$/.test(hash)) throw new ExplorerError("protocolInvalid");
  }
  if (value.leaseId !== undefined && (value.status !== "current" || typeof value.leaseId !== "string" || !/^[0-9a-f]{64}$/.test(value.leaseId))) {
    throw new ExplorerError("protocolInvalid");
  }
  const config = { path: absolute(value.path), status: value.status as ConfigStatus, token: value.preview_token as string,
    context: name(ownership.context), fingerprint: ownership.input_fingerprint as string, body: ownership.body_sha256 as string,
    ...(value.leaseId === undefined ? {} : { lease: value.leaseId as string }) };
  return config;
}

/** Domain codes remain machine identities and are translated by the language controller's UI. */
export function analyzerFailure(error: unknown): string | undefined {
  return error instanceof ExplorerError && error.domain === "analyzer_configuration_failed" && typeof error.details?.code === "string"
    ? error.details.code : undefined;
}

/** A failed selected entry still supplies a checked location to observe for recovery. */
export function libraryFailure(error: unknown): LibraryReference | undefined {
  const data = error instanceof ExplorerError && analyzerFailure(error) === "context" ? error.details?.data : undefined;
  if (!isRecord(data) || !["library_configuration", "library_source"].includes(data.reason as string)) return undefined;
  try { return libraryReference({ name: data.library, configuration: data.configuration }); }
  catch { return undefined; }
}
