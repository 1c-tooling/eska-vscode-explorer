import { isRecord } from "../protocol.js";

export type ToolKind = "project" | "analyzer";
export const TOOL_NAMES = { project: "eska-project", analyzer: "bsl-analyzer-app" } as const;
export const ANALYZER_VERSION = "0.3.2";
export const ANALYZER_CONTRACT = "3.4";
export const PROJECT_CONFIG = "designer-xml-1";
export const TARGETS = ["aarch64-apple-darwin", "aarch64-unknown-linux-gnu", "aarch64-unknown-linux-musl",
  "x86_64-apple-darwin", "x86_64-unknown-linux-gnu", "x86_64-unknown-linux-musl", "x86_64-pc-windows-msvc"] as const;
export type NativeTarget = typeof TARGETS[number];
export type ToolFailureCode = "cancelled" | "probe" | "incompatible" | "unsupportedTarget" | "releaseUnavailable"
  | "network" | "checksum" | "archive" | "receipt" | "modified" | "unmanaged" | "busy" | "io" | "recovery";

/** Installation failures retain stable technical categories; the UI owns both translations. */
export class ToolFailure extends Error {
  constructor(readonly code: ToolFailureCode, readonly detail = "", options?: ErrorOptions) {
    super(code, options);
    this.name = "ToolFailure";
  }
}

export interface ProjectContract {
  schema_version: 2;
  tool: "eska-project";
  target: NativeTarget;
  version: string;
  config_schema: typeof PROJECT_CONFIG;
  bridge_schema: 1;
  metadata_api: { major: 1; minor: number };
}

/** Release metadata never interprets prereleases, leading zeros or unsafe integers as stable versions. */
export function stableVersion(value: unknown): string {
  if (typeof value !== "string" || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(value)
    || !value.split(".").map(Number).every(Number.isSafeInteger)) throw new ToolFailure("incompatible", "stable-version");
  return value;
}

/** Full field sets prevent partial manifests from becoming accepted installation contracts. */
export function exactKeys(value: unknown, fields: readonly string[]): asserts value is Record<string, unknown> {
  if (!isRecord(value) || Object.keys(value).length !== fields.length || !fields.every(key => Object.hasOwn(value, key))) {
    throw new ToolFailure("incompatible", "contract-fields");
  }
}

/** Match the T97 schema independently of locale, filename and the reported release number. */
export function projectContract(value: unknown, expectedTarget?: NativeTarget): ProjectContract {
  exactKeys(value, ["schema_version", "tool", "target", "version", "config_schema", "bridge_schema", "metadata_api"]);
  exactKeys(value.metadata_api, ["major", "minor"]);
  const version = stableVersion(value.version);
  if (value.schema_version !== 2 || value.tool !== "eska-project" || value.config_schema !== PROJECT_CONFIG
    || value.bridge_schema !== 1 || !TARGETS.includes(value.target as NativeTarget)
    || (expectedTarget !== undefined && value.target !== expectedTarget) || value.metadata_api.major !== 1
    || !Number.isSafeInteger(value.metadata_api.minor) || (value.metadata_api.minor as number) < 12) {
    throw new ToolFailure("incompatible", "project-contract");
  }
  return { schema_version: 2, tool: "eska-project", target: value.target as NativeTarget, version,
    config_schema: PROJECT_CONFIG, bridge_schema: 1, metadata_api: { major: 1, minor: value.metadata_api.minor as number } };
}

/** A command name alone does not establish support for its required configuration/report flags. */
export function analyzerContract(value: unknown): string {
  if (!isRecord(value) || value.build_version !== ANALYZER_VERSION || value.contract_version !== ANALYZER_CONTRACT
    || !isRecord(value.cli) || !Array.isArray(value.cli.commands)) throw new ToolFailure("incompatible", "analyzer-contract");
  const commands = value.cli.commands.filter(isRecord);
  const check = commands.find(command => command.name === "check-config");
  const analyze = commands.find(command => command.name === "analyze");
  const lsp = commands.find(command => command.name === "lsp");
  if (!Array.isArray(lsp?.args) || !Array.isArray(check?.args) || !Array.isArray(analyze?.args)
    || !check.args.some(arg => isRecord(arg) && arg.name === "config" && arg.required === true && arg.takes_value === true)
    || !analyze.args.some(arg => isRecord(arg) && arg.name === "format" && arg.takes_value === true && Array.isArray(arg.values) && arg.values.includes("jsonl"))) {
    throw new ToolFailure("incompatible", "analyzer-commands");
  }
  return ANALYZER_VERSION;
}

/** Do not install a neighbouring architecture or silently assume a GNU runtime on musl. */
export function nativeTarget(platform: NodeJS.Platform, architecture: string, glibc = true): NativeTarget {
  if (platform === "linux" && (architecture === "x64" || architecture === "arm64")) {
    return `${architecture === "x64" ? "x86_64" : "aarch64"}-unknown-linux-${glibc ? "gnu" : "musl"}`;
  }
  if (platform === "darwin" && (architecture === "x64" || architecture === "arm64")) {
    return architecture === "x64" ? "x86_64-apple-darwin" : "aarch64-apple-darwin";
  }
  if (platform === "win32" && architecture === "x64") return "x86_64-pc-windows-msvc";
  throw new ToolFailure("unsupportedTarget", `${platform}/${architecture}`);
}

/** Upstream 0.3.2 publishes only these three app assets, independently of ESKA's target list. */
export function analyzerAsset(target: NativeTarget): string {
  switch (target) {
    case "x86_64-unknown-linux-gnu": return "bsl-analyzer-app-linux-amd64";
    case "aarch64-apple-darwin": return "bsl-analyzer-app-darwin-arm64";
    case "x86_64-pc-windows-msvc": return "bsl-analyzer-app-windows-amd64.exe";
    default: throw new ToolFailure("unsupportedTarget", target);
  }
}

/** An aborted inspection must not publish a late successful version into another selected context. */
export function assertCurrent(signal?: AbortSignal): void {
  if (signal?.aborted) throw new ToolFailure("cancelled");
}
