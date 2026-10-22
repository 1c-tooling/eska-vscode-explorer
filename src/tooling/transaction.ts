import { constants } from "node:fs";
import { chmod, copyFile, link, lstat, mkdir, readFile, readdir, rename, rm, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { ToolFailure, assertCurrent, exactKeys, type NativeTarget } from "./contracts.js";
import { checksum, destination, fileHash, readMetadata, relativePath, writeJson } from "./files.js";

type JournalTool = "eska-project" | "bsl-analyzer-app";
interface Entry { path: string; old: string | null; new: string | null; backup: string | null }
interface Journal { schema_version: 1; tool: JournalTool; target: NativeTarget; phase: "prepared" | "committed" | "rolled-back"; entries: Entry[] }

/** Shared executables and private notices are the full write boundary, including during recovery. */
function allowed(tool: JournalTool, target: NativeTarget, name: string): boolean {
  relativePath(name);
  const binary = `${tool}${target.includes("windows") ? ".exe" : ""}`;
  return name === `bin/${binary}` || name === `components/${tool}.json` || name.startsWith(`share/eska/${tool}/`);
}

/** Replacement journal markers are flushed before the corresponding filesystem phase is published. */
async function journalWrite(stage: string, value: Journal): Promise<void> {
  const next = join(stage, "journal.next");
  await writeJson(next, value);
  await rename(next, join(stage, "journal.json"));
}

/** Validate every path and checksum before treating saved data as recovery instructions. */
async function journalRead(stage: string, tool: JournalTool, target: NativeTarget): Promise<Journal> {
  if (!(await lstat(stage)).isDirectory()) throw new ToolFailure("recovery", stage);
  const value = await readMetadata(join(stage, "journal.json"), 8 * 1024 * 1024);
  exactKeys(value, ["schema_version", "tool", "target", "phase", "entries"]);
  if (value.schema_version !== 1 || value.tool !== tool || value.target !== target
    || !["prepared", "committed", "rolled-back"].includes(value.phase as string) || !Array.isArray(value.entries)
    || value.entries.length > 16385) throw new ToolFailure("recovery", stage);
  const names = new Set<string>();
  for (const [index, entry] of value.entries.entries()) {
    exactKeys(entry, ["path", "old", "new", "backup"]);
    if (typeof entry.path !== "string" || !allowed(tool, target, entry.path) || names.has(entry.path.toLowerCase())
      || (entry.old === null && entry.new === null) || entry.backup !== (entry.old === null ? null : `backup/${index}`)) throw new ToolFailure("recovery", stage);
    names.add(entry.path.toLowerCase());
    if (entry.old !== null) checksum(entry.old);
    if (entry.new !== null) checksum(entry.new);
  }
  return value as unknown as Journal;
}

/** Never restore even one target until all live files and all backups have known transaction hashes. */
export async function restoreTransaction(root: string, stage: string, tool: JournalTool, target: NativeTarget): Promise<void> {
  const journal = await journalRead(stage, tool, target);
  if (journal.phase !== "prepared") return;
  for (const entry of journal.entries) {
    const hash = await fileHash(await destination(root, entry.path));
    if (hash !== entry.old && hash !== entry.new) throw new ToolFailure("recovery", stage);
    if (entry.backup && await fileHash(await destination(stage, entry.backup)) !== entry.old) throw new ToolFailure("recovery", stage);
  }
  for (const [index, entry] of [...journal.entries.entries()].reverse()) {
    const path = await destination(root, entry.path);
    if (!entry.backup) await rm(path, { force: true });
    else {
      const backup = join(stage, entry.backup), temporary = join(stage, `restore-${index}`);
      await copyFile(backup, temporary, constants.COPYFILE_EXCL);
      await chmod(temporary, (await stat(backup)).mode & 0o777);
      await mkdir(dirname(path), { recursive: true });
      await rename(temporary, path);
    }
  }
  journal.phase = "rolled-back";
  await journalWrite(stage, journal);
}

/** Leave interrupted transaction directories intact until explicitly recovered under the shared lock. */
export async function pendingTransactions(root: string): Promise<string[]> {
  const names = await readdir(root).catch(error => { if (error.code === "ENOENT") return []; throw error; });
  const result: string[] = [];
  for (const name of names.filter(name => name.startsWith(".eska-component-"))) {
    if (await lstat(join(root, name, "journal.json")).catch(() => undefined)) result.push(join(root, name));
  }
  return result.sort();
}

/** Back up byte-verified files and publish the receipt last; any recoverable error restores the previous version. */
export async function publishTransaction(root: string, stage: string, tool: JournalTool, target: NativeTarget,
  oldFiles: Map<string, string>, newFiles: Map<string, string>, verify: () => Promise<void>, signal?: AbortSignal): Promise<void> {
  const names = [...new Set([...oldFiles.keys(), ...newFiles.keys()])].sort((a, b) => Number(a.startsWith("components/")) - Number(b.startsWith("components/")) || a.localeCompare(b, "en"));
  const journal: Journal = { schema_version: 1, tool, target, phase: "prepared", entries: [] };
  await mkdir(join(stage, "backup"));
  for (const [index, name] of names.entries()) {
    if (!allowed(tool, target, name)) throw new ToolFailure("archive", name);
    const path = await destination(root, name), old = oldFiles.get(name) ?? null;
    if (await fileHash(path) !== old) throw new ToolFailure("modified", path);
    const backup = old ? `backup/${index}` : null;
    if (backup) {
      await copyFile(path, join(stage, backup), constants.COPYFILE_EXCL);
      await chmod(join(stage, backup), (await stat(path)).mode & 0o777);
      if (await fileHash(join(stage, backup)) !== old) throw new ToolFailure("modified", path);
    }
    const incoming = newFiles.get(name), next = incoming ? await fileHash(incoming) : null;
    journal.entries.push({ path: name, old, new: next, backup });
  }
  assertCurrent(signal);
  await journalWrite(stage, journal);
  try {
    for (const entry of journal.entries) {
      assertCurrent(signal);
      const path = await destination(root, entry.path);
      if (await fileHash(path) !== entry.old) throw new ToolFailure("modified", path);
      const incoming = newFiles.get(entry.path);
      if (!incoming) await rm(path);
      else {
        await mkdir(dirname(path), { recursive: true });
        if (entry.old === null) await link(incoming, path);
        else await rename(incoming, path);
      }
    }
    await verify(); assertCurrent(signal);
    journal.phase = "committed"; await journalWrite(stage, journal);
  } catch (error) {
    try { await restoreTransaction(root, stage, tool, target); }
    catch (rollback) { throw new ToolFailure("recovery", stage, { cause: rollback }); }
    throw error;
  }
}

/** Failed rollback preserves the journal and backups; all completed/pre-publication stages can be removed. */
export async function cleanStage(stage: string): Promise<void> {
  const data = await readFile(join(stage, "journal.json"), "utf8").catch(() => undefined);
  if (data && (JSON.parse(data) as Journal).phase === "prepared") return;
  await rm(stage, { recursive: true, force: true });
}
