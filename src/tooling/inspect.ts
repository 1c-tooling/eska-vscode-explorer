import { access, realpath, stat } from "node:fs/promises";
import { constants } from "node:fs";
import { delimiter, isAbsolute, join } from "node:path";
import { BASE_API_VERSION, ExplorerError, parseHandshake } from "../protocol.js";
import { BackendProcess } from "../process.js";
import { runProbe } from "../installation.js";
import type { DiagnosticLog } from "../diagnostics.js";
import { ANALYZER_VERSION, ToolFailure, analyzerContract, assertCurrent, projectContract, type ProjectContract, type ToolKind } from "./contracts.js";

export interface ToolInfo { kind: ToolKind; path: string; version: string }

/** Explicit paths never fall back; default discovery ignores relative PATH entries. */
export async function findTool(configured: string, name: string, managedBin: string, paths = process.env.PATH ?? ""): Promise<string | undefined> {
  if (!configured || configured !== configured.trim() || configured.includes("\0")) throw new ExplorerError("invalidExecutable");
  if (isAbsolute(configured)) return executable(configured);
  if (/[\\/]/.test(configured)) throw new ExplorerError("invalidExecutable");
  const filename = process.platform === "win32" && !configured.toLowerCase().endsWith(".exe") ? `${configured}.exe` : configured;
  const directories = configured === name ? [managedBin, ...paths.split(delimiter).filter(isAbsolute)] : paths.split(delimiter).filter(isAbsolute);
  for (const directory of directories) {
    const path = await executable(join(directory, filename));
    if (path) return path;
  }
  return undefined;
}

/** Resolve the chosen regular executable rather than adopting its directory or a workspace script. */
async function executable(path: string): Promise<string | undefined> {
  try {
    await access(path, constants.X_OK);
    if ((await stat(path)).isFile()) return await realpath(path);
  } catch { /* Missing candidates stay missing; explicit selection is not replaced by another path. */ }
  return undefined;
}

/** Custom project builds use their real Metadata API; installation contracts are required only for managed archives. */
export async function inspectProject(path: string, cwd: string, log: DiagnosticLog, signal?: AbortSignal): Promise<ToolInfo> {
  assertCurrent(signal);
  const child = new BackendProcess({ executable: path, cwd, args: ["serve", "--stdio"], log, failed() {}, ...(signal ? { signal } : {}) });
  try {
    // Probe the minimum tree contract; a connected session negotiates optional query capabilities.
    const hello = await child.request("initialize", { apiVersion: BASE_API_VERSION, client: { name: "eska-explorer", version: "tool-probe" },
      locale: "en-US", allowPropertyEdits: true }, 10_000);
    assertCurrent(signal);
    const version = parseHandshake(hello);
    if (!/^[\x20-\x7e]{1,128}$/.test(version)) throw new ToolFailure("incompatible", "project-version");
    return { kind: "project", path, version };
  } finally { await child.stop("tool-probe"); assertCurrent(signal); }
}

/** Await both bounded probes even if one fails, so cancellation/deactivation cannot abandon its peer. */
export async function inspectAnalyzer(path: string, cwd: string, signal?: AbortSignal): Promise<ToolInfo> {
  assertCurrent(signal);
  const results = await Promise.allSettled([
    runProbe(path, ["--version"], cwd, 10_000, 65536, signal),
    runProbe(path, ["contract"], cwd, 10_000, 1_048_576, signal),
  ]);
  assertCurrent(signal);
  const [version, contract] = results;
  if (version.status === "rejected" || contract.status === "rejected") throw new ToolFailure("probe", path);
  const reported = version.value.stdout.trim().replace(/^bsl-analyzer(?:-app)? /, "");
  let value: unknown;
  try { value = JSON.parse(contract.value.stdout); }
  catch { throw new ToolFailure("incompatible", "analyzer-json"); }
  if (reported !== ANALYZER_VERSION || analyzerContract(value) !== reported) throw new ToolFailure("incompatible", "analyzer-version");
  return { kind: "analyzer", path, version: reported };
}

/** A downloaded executable must declare the exact target and package identity before publication. */
export async function inspectProjectContract(path: string, cwd: string, expected: ProjectContract, log: DiagnosticLog, signal?: AbortSignal): Promise<ToolInfo> {
  const result = await runProbe(path, ["__tool-contract"], cwd, 10_000, 65536, signal);
  assertCurrent(signal);
  let value: unknown;
  try { value = JSON.parse(result.stdout); }
  catch { throw new ToolFailure("incompatible", "project-json"); }
  const actual = projectContract(value, expected.target);
  if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new ToolFailure("incompatible", "project-package");
  const info = await inspectProject(path, cwd, log, signal);
  assertCurrent(signal);
  if (info.version !== actual.version) throw new ToolFailure("incompatible", "project-version");
  return info;
}
