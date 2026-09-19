import { execFile } from "node:child_process";
import { access, realpath, readFile, mkdtemp, writeFile, rm } from "node:fs/promises";
import { constants } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, isAbsolute, join, delimiter } from "node:path";
import { promisify } from "node:util";
import { BackendProcess } from "./process.js";
import { API_VERSION, ExplorerError, isRecord, parseHandshake } from "./protocol.js";
import type { DiagnosticLog } from "./diagnostics.js";

const execute = promisify(execFile);
export const MIN_CLI_VERSION = "0.11.0";
const RELEASES = "https://api.github.com/repos/1c-tooling/eska/releases";
export interface GlobalCli { path: string; version: string; compatible: boolean; selfUpdate: boolean }
export interface Release { version: string; installer: string }
export interface InstallCommand { executable: string; args: string[]; cwd: string; env?: Record<string, string>; dispose(): Promise<void> }

/** Compare stable release triples, rejecting malformed output instead of interpreting arbitrary text. */
export function compareVersions(left: string, right: string): number {
  const parse = (value: string): number[] => {
    if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(value)) throw new ExplorerError("protocolInvalid");
    const parts = value.split(".").map(Number);
    if (!parts.every(Number.isSafeInteger)) throw new ExplorerError("protocolInvalid");
    return parts;
  };
  const a = parse(left), b = parse(right);
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i]! < b[i]! ? -1 : 1;
  return 0;
}

/** Resolve only absolute PATH entries, never an executable from an untrusted working directory. */
export async function findGlobal(paths = process.env.PATH ?? "", home = homedir(), platform = process.platform): Promise<string | undefined> {
  const name = platform === "win32" ? "eska.exe" : "eska";
  const directories = [...paths.split(delimiter).filter(isAbsolute), join(home, ".eska", "bin")];
  for (const directory of directories) {
    const candidate = join(directory, name);
    try { await access(candidate, constants.X_OK); return await realpath(candidate); } catch { /* Continue to the next installation. */ }
  }
  return undefined;
}

/** Probe the global CLI independently of a development override, without opening or indexing a project. */
export async function inspectGlobal(log: DiagnosticLog): Promise<GlobalCli | undefined> {
  const path = await findGlobal();
  if (!path) return undefined;
  const { stdout } = await execute(path, ["--version"], { cwd: homedir(), timeout: 10_000, maxBuffer: 64 * 1024, windowsHide: true });
  const version = stdout.trim().replace(/^eska /, "");
  const result: GlobalCli = { path, version, compatible: false, selfUpdate: false };
  if (compareVersions(version, MIN_CLI_VERSION) < 0) return result;
  const child = new BackendProcess({ executable: path, cwd: homedir(), log, failed() {} });
  try {
    const hello = await child.request("initialize", { apiVersion: API_VERSION, client: { name: "eska-explorer", version: "probe" }, locale: "en-US" }, 10_000);
    parseHandshake(hello);
    result.compatible = true;
    result.selfUpdate = isRecord(hello) && isRecord(hello.capabilities) && hello.capabilities.selfUpdate === true;
  } catch (error) {
    if (!(error instanceof ExplorerError)) throw error;
  } finally { await child.stop("probe"); }
  return result;
}

/** Download a bounded official response; non-success HTTP statuses never become executable content. */
export async function fetchText(url: string, limit: number): Promise<string> {
  const response = await fetch(url, { headers: { "User-Agent": "eska-explorer", "Accept": "application/vnd.github+json" }, signal: AbortSignal.timeout(30_000) });
  if (!response.ok || !response.body) throw new ExplorerError("updateFailed");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) throw new ExplorerError("updateFailed");
      chunks.push(value);
    }
  } finally { await reader.cancel(); }
  return Buffer.concat(chunks).toString("utf8");
}

/** Accept only stable official release assets; installer URLs are never taken from workspace configuration. */
export function parseRelease(value: unknown, platform = process.platform): Release {
  if (!isRecord(value) || value.draft !== false || value.prerelease !== false || typeof value.tag_name !== "string" || !Array.isArray(value.assets)) throw new ExplorerError("updateFailed");
  const version = value.tag_name.replace(/^v/, "");
  if (compareVersions(version, MIN_CLI_VERSION) < 0) throw new ExplorerError("incompatible");
  const name = platform === "win32" ? "eska-installer.ps1" : "eska-installer.sh";
  const expected = `https://github.com/1c-tooling/eska/releases/download/${value.tag_name}/${name}`;
  if (!value.assets.some(asset => isRecord(asset) && asset.name === name && asset.browser_download_url === expected)) throw new ExplorerError("updateFailed");
  return { version, installer: expected };
}

/** Resolve the current stable published release, without downloading an installer yet. */
export async function latestRelease(): Promise<Release> { return parseRelease(JSON.parse(await fetchText(`${RELEASES}/latest`, 2 * 1024 * 1024))); }

/** Native update JSON contains no localized text and is validated before use in the UI. */
export async function checkUpdate(cli: GlobalCli): Promise<{ version: string | undefined; method: string }> {
  const { stdout } = await execute(cli.path, ["update", "--check", "--format", "json"], { cwd: homedir(), timeout: 45_000, maxBuffer: 1024 * 1024, windowsHide: true });
  const result: unknown = JSON.parse(stdout);
  if (!isRecord(result) || result.schemaVersion !== 1 || !["up-to-date", "update-available"].includes(String(result.status))
    || !["cargo", "installer"].includes(String(result.method)) || typeof result.availableVersion !== "string") throw new ExplorerError("updateFailed");
  compareVersions(result.availableVersion, cli.version);
  return { version: result.status === "update-available" ? result.availableVersion : undefined, method: String(result.method) };
}

/** Validate the selected release against Cargo's index without depending on the crates.io web API. */
export function assertCargoRelease(index: string, version: string): void {
  compareVersions(version, MIN_CLI_VERSION);
  const entries: unknown[] = index.split(/\r?\n/).filter(line => line.trim()).map(line => JSON.parse(line));
  if (!entries.some(entry => isRecord(entry) && entry.name === "eska" && entry.vers === version
    && entry.yanked === false && (entry.v === undefined || entry.v === 1 || entry.v === 2))) throw new ExplorerError("updateFailed");
}

/** Preserve Cargo options during the one-time bootstrap from releases without `eska update`. */
export async function bootstrapCommand(cli: GlobalCli | undefined, release: Release): Promise<InstallCommand> {
  if (cli) {
    const root = dirname(dirname(cli.path));
    let metadata: unknown;
    try { metadata = JSON.parse(await readFile(join(root, ".crates2.json"), "utf8")); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new ExplorerError("updateFailed"); }
    if (metadata !== undefined) {
      const key = `eska ${cli.version} (registry+https://github.com/rust-lang/crates.io-index)`;
      const entry = isRecord(metadata) && isRecord(metadata.installs) ? metadata.installs[key] : undefined;
      if (!isRecord(entry) || !Array.isArray(entry.features) || !entry.features.every(value => typeof value === "string")
        || typeof entry.profile !== "string" || typeof entry.target !== "string"
        || typeof entry.all_features !== "boolean" || typeof entry.no_default_features !== "boolean"
        || !Array.isArray(entry.bins) || !entry.bins.includes(process.platform === "win32" ? "eska.exe" : "eska")) throw new ExplorerError("updateFailed");
      const { stdout } = await execute("cargo", ["install", "--list", "--root", root], { cwd: root, timeout: 10_000, maxBuffer: 1024 * 1024, windowsHide: true });
      if (!stdout.split(/\r?\n/).includes(`eska v${cli.version}:`)) throw new ExplorerError("updateFailed");
      // A GitHub release can appear before its Cargo publication; never silently switch channels.
      assertCargoRelease(await fetchText("https://index.crates.io/es/ka/eska", 4 * 1024 * 1024), release.version);
      const args = ["install", "eska", "--locked", "--registry", "crates-io", "--version", release.version, "--root", root, "--profile", entry.profile, "--target", entry.target];
      if (entry.all_features === true) args.push("--all-features");
      if (entry.no_default_features === true) args.push("--no-default-features");
      if (entry.features.length) args.push("--features", entry.features.join(","));
      return { executable: "cargo", args, cwd: root, async dispose() {} };
    }
  }
  const folder = await mkdtemp(join(tmpdir(), "eska-installer-"));
  try {
    const windows = process.platform === "win32";
    const file = join(folder, windows ? "install.ps1" : "install.sh");
    await writeFile(file, await fetchText(release.installer, 2 * 1024 * 1024), { mode: 0o600 });
    return { executable: windows ? "powershell.exe" : "/bin/sh", args: windows ? ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", file] : [file],
      cwd: homedir(), env: { ESKA_INSTALL_DIR: join(homedir(), ".eska", "bin"), ESKA_NO_MODIFY_PATH: "", INSTALLER_NO_MODIFY_PATH: "", ESKA_UNMANAGED_INSTALL: "" },
      async dispose() { await rm(folder, { recursive: true, force: true }); } };
  } catch (error) { await rm(folder, { recursive: true, force: true }); throw error; }
}
