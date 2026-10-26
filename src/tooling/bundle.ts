import { lstat } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { compareVersions, runProbe } from "../installation.js";
import { isRecord, isWirePath } from "../protocol.js";
import { nativePath } from "../source.js";
import type { DiagnosticLog } from "../diagnostics.js";
import { ToolFailure, assertCurrent, stableVersion } from "./contracts.js";
import { destination, fileHash, installationLock, readMetadata } from "./files.js";
import { inspectProject, type ToolInfo } from "./inspect.js";
import { pendingTransactions } from "./transaction.js";

const COMPONENTS = ["eska", "eska-project", "eska-check", "eska-build", "eska-vcs"];
export interface BundleUpdate { cli: string; project: string; version: string; available: string; identity: string }

/** Follow axoupdater's receipt search order, including its explicit configuration overrides. */
async function installerReceipt(): Promise<unknown> {
  const env = process.env;
  const directories = env.AXOUPDATER_CONFIG_WORKING_DIR !== undefined ? [homedir()]
    : env.AXOUPDATER_CONFIG_PATH !== undefined ? [env.AXOUPDATER_CONFIG_PATH]
      : [env.XDG_CONFIG_HOME && join(env.XDG_CONFIG_HOME, "eska"),
        process.platform === "win32" ? env.LOCALAPPDATA && join(env.LOCALAPPDATA, "eska") : join(homedir(), ".config", "eska")];
  for (const directory of directories) {
    if (directory === undefined) continue;
    if (!isAbsolute(directory)) throw new ToolFailure("receipt", "cargo-dist-path");
    try { return await readMetadata(join(directory, "eska-receipt.json")); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
  return undefined;
}

/** A bundle receipt must own both commands at the managed destination, without component receipts. */
async function ownedBundle(root: string): Promise<{ cli: string; project: string; identity: string } | undefined> {
  const suffix = process.platform === "win32" ? ".exe" : "";
  const project = await destination(root, `bin/eska-project${suffix}`);
  if (await fileHash(project) === null) return undefined;
  const receipt = await installerReceipt();
  if (receipt === undefined) return undefined;
  const pending = await pendingTransactions(root);
  if (pending.length) throw new ToolFailure("recovery", pending[0]);
  const binaries = COMPONENTS.map(name => `${name}${suffix}`);
  if (!isRecord(receipt) || !isRecord(receipt.source) || receipt.source.owner !== "1c-tooling"
    || receipt.source.name !== "eska" || receipt.source.app_name !== "eska" || receipt.source.release_type !== "github"
    || !isRecord(receipt.provider) || receipt.provider.source !== "cargo-dist" || receipt.install_layout !== "flat"
    || typeof receipt.install_prefix !== "string" || !isAbsolute(receipt.install_prefix)
    || resolve(receipt.install_prefix) !== resolve(root, "bin") || !Array.isArray(receipt.binaries)
    || receipt.binaries.length !== binaries.length || !binaries.every(name => (receipt.binaries as unknown[]).includes(name))) {
    throw new ToolFailure("unmanaged", project);
  }
  const hashes: string[] = [];
  for (const component of COMPONENTS) {
    const metadata = await destination(root, `components/${component}.json`);
    const exists = await lstat(metadata).catch(error => { if (error.code !== "ENOENT") throw error; return undefined; });
    if (exists) throw new ToolFailure("unmanaged", metadata);
    const path = await destination(root, `bin/${component}${suffix}`), hash = await fileHash(path);
    if (!hash) throw new ToolFailure("unmanaged", path);
    hashes.push(hash);
  }
  return { cli: join(root, "bin", `eska${suffix}`), project, identity: JSON.stringify([receipt, hashes]) };
}

/** Probe the exact adjacent CLI; PATH and the removed legacy IDE command cannot select another install. */
export async function inspectBundle(root: string, signal?: AbortSignal): Promise<BundleUpdate | undefined> {
  const owned = await ownedBundle(root);
  assertCurrent(signal);
  if (!owned) return undefined;
  const version = stableVersion((await runProbe(owned.cli, ["--version"], homedir(), 10_000, 65536, signal)).stdout.trim().replace(/^eska /, ""));
  const projectVersion = (await runProbe(owned.project, ["--version"], homedir(), 10_000, 65536, signal)).stdout.trim().replace(/^eska-project /, "");
  if (projectVersion !== version) throw new ToolFailure("incompatible", "bundle-version");
  const result: unknown = JSON.parse((await runProbe(owned.cli, ["update", "--check", "--format", "json"], homedir(), 45_000, 1048576, signal)).stdout);
  assertCurrent(signal);
  if (!isRecord(result) || result.schemaVersion !== 1 || result.method !== "installer"
    || !["up-to-date", "update-available"].includes(String(result.status)) || result.installedVersion !== version
    || !isWirePath(result.executable) || resolve(nativePath(result.executable)) !== resolve(owned.cli)) {
    throw new ToolFailure("unmanaged", owned.cli);
  }
  const available = stableVersion(result.availableVersion);
  if ((compareVersions(available, version) > 0) !== (result.status === "update-available")) throw new ToolFailure("probe", "update-version");
  return { ...owned, version, available };
}

/** Keep the original channel and pin the approved release; never adopt these files as component archives. */
export async function installBundle(root: string, update: BundleUpdate,
  execute: (cli: string, args: string[]) => Promise<void>, log: DiagnosticLog, signal?: AbortSignal): Promise<ToolInfo> {
  return installationLock(root, signal, async () => {
    const owned = await ownedBundle(root);
    assertCurrent(signal);
    if (!owned || owned.identity !== update.identity || owned.cli !== update.cli) throw new ToolFailure("modified", "cargo-dist");
    await execute(update.cli, ["update", "--target-version", update.available, "--format", "json"]);
    assertCurrent(signal);
    const info = await inspectProject(update.project, homedir(), log, signal);
    if (info.version !== update.available) throw new ToolFailure("probe", "bundle-version");
    return info;
  });
}
