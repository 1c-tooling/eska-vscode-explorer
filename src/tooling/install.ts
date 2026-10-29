import { createHash } from "node:crypto";
import { chmod, copyFile, lstat, mkdtemp, statfs, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { compareVersions } from "../installation.js";
import { isRecord } from "../protocol.js";
import type { DiagnosticLog } from "../diagnostics.js";
import { PROJECT_CONFIG, ToolFailure, assertCurrent, exactKeys, stableVersion, TOOL_NAMES, type NativeTarget, type ToolKind, type ComponentName } from "./contracts.js";
import { componentPackage, unpackComponent, type ComponentPackage } from "./archive.js";
import { checksum, destination, fileHash, installationLock, readMetadata, recoverAbandonedClaim, writeJson } from "./files.js";
import { inspectAnalyzer, inspectComponentContract, type ToolInfo } from "./inspect.js";
import { hostTarget, type ToolRelease } from "./releases.js";
import { cleanStage, pendingTransactions, publishTransaction, restoreTransaction } from "./transaction.js";

interface ComponentReceipt { schema_version: 1; method: "component-archive"; archive_sha256: string; package: ComponentPackage }
interface AnalyzerReceipt { schema_version: 1; method: "upstream-binary"; version: string; target: NativeTarget; sha256: string; size: number; files: Record<string, string> }

/** Analyzer files have their own private root; the T97 root keeps only ESKA component receipts. */
export function toolRoot(root: string, kind: ToolKind): string { return kind === "analyzer" ? join(root, "analyzer") : root; }

/** Stable paths are independent of whichever executable a user explicitly selected. */
export function managedPath(root: string, kind: ToolKind, target?: NativeTarget): string {
  const windows = target ? target.includes("windows") : process.platform === "win32";
  return join(toolRoot(root, kind), "bin", `${TOOL_NAMES[kind]}${windows ? ".exe" : ""}`);
}

/** Map package notices into the exact namespace also owned by the Python installer. */
function componentFiles(value: ComponentPackage): Map<string, string> {
  return new Map(value.files.map(item => [item.executable ? item.path : `share/eska/${value.tool}/${item.path.slice("licenses/".length)}`, item.sha256]));
}

/** A missing receipt never authorizes replacement of an existing executable. */
async function componentReceipt(root: string, target: NativeTarget, tool: ComponentName = "eska-project"): Promise<ComponentReceipt | undefined> {
  const path = await destination(root, `components/${tool}.json`);
  if (!await lstat(path).catch(error => { if (error.code === "ENOENT") return undefined; throw error; })) return undefined;
  const value = await readMetadata(path);
  exactKeys(value, ["schema_version", "method", "archive_sha256", "package"]);
  if (value.schema_version !== 1 || value.method !== "component-archive") throw new ToolFailure("unmanaged", path);
  return { schema_version: 1, method: "component-archive", archive_sha256: checksum(value.archive_sha256), package: componentPackage(value.package, target, tool) };
}

/** Reject incompatible neighbouring components while preserving their files and independent versions. */
async function compatibleNeighbours(root: string, target: NativeTarget, selected: ComponentName): Promise<void> {
  for (const tool of ["eska", "eska-project", "eska-check", "eska-build", "eska-vcs", "eska-fmt"]) {
    if (tool === selected) continue;
    const path = await destination(root, `components/${tool}.json`);
    if (!await lstat(path).catch(error => { if (error.code === "ENOENT") return undefined; throw error; })) continue;
    const receipt = await readMetadata(path);
    exactKeys(receipt, ["schema_version", "method", "archive_sha256", "package"]);
    if (receipt.schema_version !== 1 || receipt.method !== "component-archive" || !isRecord(receipt.package)) throw new ToolFailure("incompatible", tool);
    checksum(receipt.archive_sha256);
    const contract = receipt.package.contract;
    exactKeys(contract, ["schema_version", "tool", "target", "version", "config_schema", "bridge_schema", "metadata_api"]);
    stableVersion(contract.version);
    if (tool === "eska-project") exactKeys(contract.metadata_api, ["major", "minor"]);
    if (contract.schema_version !== 2 || contract.tool !== tool || contract.target !== target || contract.config_schema !== PROJECT_CONFIG
      || contract.bridge_schema !== 1 || (tool === "eska-project" ? !isRecord(contract.metadata_api) || contract.metadata_api.major !== 1
        || !Number.isSafeInteger(contract.metadata_api.minor) || (contract.metadata_api.minor as number) < 12 : contract.metadata_api !== null)
      || receipt.package.version !== contract.version
      || receipt.package.tool !== tool || receipt.package.target !== target) throw new ToolFailure("incompatible", tool);
  }
}

/** Validate all prior owned bytes before replacement, including notices and the receipt itself. */
async function verifyFiles(root: string, files: Map<string, string>): Promise<void> {
  for (const [name, expected] of files) {
    const path = await destination(root, name);
    if (await fileHash(path) !== expected) throw new ToolFailure("modified", path);
  }
}

/** Reject unmanaged collisions, pending recovery, downgrades and changed payloads under the same version. */
async function preflight(root: string, old: Map<string, string>, next: Iterable<string>, current: string | undefined,
  release: ToolRelease, same: boolean): Promise<void> {
  const pending = await pendingTransactions(root);
  if (pending.length) throw new ToolFailure("recovery", pending[0]);
  if (current && (compareVersions(release.version, current) < 0 || (release.version === current && !same))) throw new ToolFailure("incompatible", "version-replacement");
  await verifyFiles(root, old);
  for (const name of next) if (!old.has(name) && await fileHash(await destination(root, name)) !== null) throw new ToolFailure("unmanaged", name);
}

/** Both frontends compute receipts identically enough to verify and update each other's managed project files. */
async function receiptHash(root: string, name: string, files: Map<string, string>): Promise<void> {
  const hash = await fileHash(await destination(root, name));
  if (hash) files.set(name, hash);
}

/** Only exact downloaded bytes can enter the staging/probe/publication sequence. */
function verified(release: ToolRelease, data: Buffer, kind: ToolKind): void {
  if (release.kind !== kind || release.restriction || !release.asset || release.target !== hostTarget()) throw new ToolFailure("incompatible", "release");
  if (data.length !== release.asset.size || createHash("sha256").update(data).digest("hex") !== checksum(release.asset.sha256)) throw new ToolFailure("checksum");
}

/** Install one project/formatter archive without the monolith, Python, Cargo, Git or a platform runtime. */
export async function installComponent(root: string, data: Buffer, release: ToolRelease, log: DiagnosticLog, signal?: AbortSignal): Promise<ToolInfo> {
  if (release.kind === "analyzer") throw new ToolFailure("incompatible", "component-kind");
  const kind = release.kind, tool = TOOL_NAMES[kind];
  verified(release, data, kind);
  return installationLock(root, signal, async () => {
    const stage = await mkdtemp(join(root, ".eska-component-"));
    try {
      const payload = join(stage, "payload"), value = await unpackComponent(data, payload, release.target, signal, tool);
      if (value.version !== release.version) throw new ToolFailure("incompatible", "release-version");
      await compatibleNeighbours(root, release.target, tool);
      const previous = await componentReceipt(root, release.target, tool), old = previous ? componentFiles(previous.package) : new Map<string, string>();
      const next = componentFiles(value), same = previous?.archive_sha256 === release.asset!.sha256;
      await preflight(root, old, next.keys(), previous?.package.version, release, same);
      const path = managedPath(root, kind, release.target);
      // The probe uses stage as its cwd; finally must not remove it before every child exits.
      if (same) return await inspectComponentContract(path, stage, value.contract, log, signal);
      const space = await statfs(root), required = [...value.files, ...(previous?.package.files ?? [])].reduce((sum, item) => sum + item.size, 0);
      if (space.bavail * space.bsize < required + 16 * 1024 * 1024) throw new ToolFailure("io", "space");
      const executable = value.files.find(item => item.executable)!;
      await inspectComponentContract(join(payload, executable.path), stage, value.contract, log, signal);
      const receipt = { schema_version: 1, method: "component-archive", archive_sha256: release.asset!.sha256, package: value };
      await writeJson(join(stage, "receipt.json"), receipt);
      const receiptName = `components/${tool}.json`;
      if (previous) await receiptHash(root, receiptName, old);
      const incoming = new Map(value.files.map(item => [item.executable ? item.path : `share/eska/${value.tool}/${item.path.slice(9)}`, join(payload, item.path)]));
      incoming.set(receiptName, join(stage, "receipt.json"));
      let info: ToolInfo | undefined;
      await publishTransaction(root, stage, tool, release.target, old, incoming, async () => {
        await verifyFiles(root, next);
        info = await inspectComponentContract(path, stage, value.contract, log, signal);
      }, signal);
      return info!;
    } finally { await cleanStage(stage); }
  });
}

/** Analyzer receipts own the exact fixed binary and bundled upstream notices in their private namespace. */
async function analyzerReceipt(root: string, target: NativeTarget): Promise<AnalyzerReceipt | undefined> {
  const path = await destination(root, "components/bsl-analyzer-app.json");
  if (!await lstat(path).catch(error => { if (error.code === "ENOENT") return undefined; throw error; })) return undefined;
  const value = await readMetadata(path);
  exactKeys(value, ["schema_version", "method", "version", "target", "sha256", "size", "files"]);
  stableVersion(value.version);
  if (value.schema_version !== 1 || value.method !== "upstream-binary" || value.target !== target
    || !Number.isSafeInteger(value.size) || (value.size as number) <= 0 || !isRecord(value.files)) throw new ToolFailure("receipt", path);
  const binary = `bin/bsl-analyzer-app${target.includes("windows") ? ".exe" : ""}`;
  for (const [name, hash] of Object.entries(value.files)) {
    if (name !== binary && !/^share\/eska\/bsl-analyzer-app\/(LICENSE-(APACHE|GPL|LGPL|MIT)|NOTICE)$/.test(name)) throw new ToolFailure("receipt", name);
    checksum(hash);
  }
  if (Object.keys(value.files).length !== 6 || value.files[binary] !== checksum(value.sha256)) throw new ToolFailure("receipt", path);
  return value as unknown as AnalyzerReceipt;
}

/** The upstream app remains an independent raw executable; no ESKA package or source rebuild is substituted. */
export async function installAnalyzer(root: string, data: Buffer, release: ToolRelease, notices: string, signal?: AbortSignal): Promise<ToolInfo> {
  verified(release, data, "analyzer");
  root = toolRoot(root, "analyzer");
  return installationLock(root, signal, async () => {
    const stage = await mkdtemp(join(root, ".eska-component-"));
    /** Bind both staged and published executables to the downloaded release identity. */
    const inspect = async (path: string): Promise<ToolInfo> => {
      const info = await inspectAnalyzer(path, stage, signal);
      if (info.version !== release.version) throw new ToolFailure("incompatible", "analyzer-release-version");
      return info;
    };
    try {
      const space = await statfs(root);
      if (space.bavail * space.bsize < data.length * 2 + 16 * 1024 * 1024) throw new ToolFailure("io", "space");
      const previous = await analyzerReceipt(root, release.target), old = new Map(Object.entries(previous?.files ?? {}));
      const name = `bin/bsl-analyzer-app${release.target.includes("windows") ? ".exe" : ""}`, binary = join(stage, "bsl-analyzer-app" + (release.target.includes("windows") ? ".exe" : ""));
      await writeFile(binary, data, { flag: "wx", mode: 0o755 }); await chmod(binary, 0o755);
      const incoming = new Map([[name, binary]]), next = new Map([[name, release.asset!.sha256]]);
      for (const notice of ["LICENSE-APACHE", "LICENSE-GPL", "LICENSE-LGPL", "LICENSE-MIT", "NOTICE"]) {
        const source = join(notices, notice), output = join(stage, notice), key = `share/eska/bsl-analyzer-app/${notice}`;
        await copyFile(source, output);
        incoming.set(key, output); next.set(key, (await fileHash(output))!);
      }
      const same = previous?.sha256 === release.asset!.sha256;
      await preflight(root, old, next.keys(), previous?.version, release, same);
      const path = join(root, name);
      // Reinstall retains its working directory until both read-only probe processes finish.
      if (same) return await inspect(path);
      await inspect(binary); assertCurrent(signal);
      const receiptName = "components/bsl-analyzer-app.json";
      await writeJson(join(stage, "receipt.json"), { schema_version: 1, method: "upstream-binary", version: release.version,
        target: release.target, sha256: release.asset!.sha256, size: data.length, files: Object.fromEntries(next) });
      incoming.set(receiptName, join(stage, "receipt.json"));
      if (previous) await receiptHash(root, receiptName, old);
      let info: ToolInfo | undefined;
      await publishTransaction(root, stage, "bsl-analyzer-app", release.target, old, incoming, async () => {
        await verifyFiles(root, next); info = await inspect(path);
      }, signal);
      return info!;
    } finally { await cleanStage(stage); }
  });
}

/** Managed version lookup is local; selecting a custom executable never adopts it into these receipts. */
export async function managedVersion(root: string, kind: ToolKind, target = hostTarget()): Promise<string | undefined> {
  return kind === "analyzer" ? (await analyzerReceipt(toolRoot(root, kind), target))?.version : (await componentReceipt(root, target, TOOL_NAMES[kind]))?.package.version;
}

/** Explicit recovery restores verified transactions only and never removes unrecognized temporary/user directories. */
export async function recoverInstallation(root: string, kind: ToolKind, target = hostTarget()): Promise<void> {
  root = toolRoot(root, kind);
  await recoverAbandonedClaim(root);
  await installationLock(root, undefined, async () => {
    for (const stage of await pendingTransactions(root)) {
      await restoreTransaction(root, stage, TOOL_NAMES[kind], target);
      await cleanStage(stage);
    }
  });
}
