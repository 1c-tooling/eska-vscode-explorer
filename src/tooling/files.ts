import { createHash, randomBytes } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, mkdir, open, readFile, realpath, rm } from "node:fs/promises";
import { dirname, isAbsolute, join, parse, resolve } from "node:path";
import { TextDecoder } from "node:util";
import { ToolFailure, assertCurrent, exactKeys } from "./contracts.js";

/** One portable namespace excludes traversal, alternate streams and Windows filename aliases. */
export function relativePath(value: unknown): string {
  if (typeof value !== "string" || !value || /[\\:\x00-\x1f]/.test(value) || value.startsWith("/")
    || value.split("/").some(part => !part || part === "." || part === ".." || /[. ]$/.test(part)
      || /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/i.test(part))) throw new ToolFailure("archive", "path");
  return value;
}

/** Keep every managed parent and leaf within the chosen real directory. */
export async function destination(root: string, name: string): Promise<string> {
  relativePath(name);
  let path = resolve(root);
  for (const part of name.split("/")) {
    path = join(path, part);
    const info = await lstat(path).catch(error => { if (error.code === "ENOENT") return undefined; throw error; });
    if (info?.isSymbolicLink() || (path !== join(root, name) && info && !info.isDirectory())) throw new ToolFailure("modified", path);
  }
  return path;
}

/** Installation roots themselves cannot redirect writes through an ancestor symlink. */
export async function prepareRoot(root: string): Promise<void> {
  if (!isAbsolute(root) || resolve(root) === parse(root).root) throw new ToolFailure("io", "root");
  let current = parse(root).root;
  for (const part of root.slice(current.length).split(/[\\/]/)) {
    if (!part) continue;
    current = join(current, part);
    const info = await lstat(current).catch(error => { if (error.code === "ENOENT") return undefined; throw error; });
    if (info && !info.isDirectory()) throw new ToolFailure("modified", current);
  }
  await mkdir(root, { recursive: true, mode: 0o700 });
  if (resolve(root) !== await realpath(root)) throw new ToolFailure("modified", root);
}

/** Hash owned regular bytes without following an unexpected leaf symlink. */
export async function fileHash(path: string): Promise<string | null> {
  const info = await lstat(path).catch(error => { if (error.code === "ENOENT") return undefined; throw error; });
  if (!info) return null;
  if (!info.isFile()) throw new ToolFailure("modified", path);
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

/** Checksums are canonical SHA-256 identities, not filenames supplied by a release. */
export function checksum(value: unknown): string {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/.test(value)) throw new ToolFailure("checksum");
  return value;
}

/** Read bounded metadata before interpreting any ownership or recovery instruction. */
export async function readMetadata(path: string, limit = 4 * 1024 * 1024): Promise<unknown> {
  const info = await lstat(path);
  if (!info.isFile() || info.size > limit) throw new ToolFailure("receipt", path);
  return strictJson(await readFile(path));
}

/** JSON.parse validates syntax; this second walk rejects duplicate keys before they lose their identity. */
export function strictJson(source: string | Uint8Array): unknown {
  try {
    const text = typeof source === "string" ? source : new TextDecoder("utf-8", { fatal: true }).decode(source);
    const value: unknown = JSON.parse(text);
    let position = 0;
    const space = (): void => { while (/\s/.test(text[position] ?? "!")) position++; };
    const string = (): string => {
      const start = position++;
      while (position < text.length) {
        const char = text[position++];
        if (char === "\\") position++;
        else if (char === '"') return JSON.parse(text.slice(start, position)) as string;
      }
      throw new Error("string");
    };
    const visit = (depth: number): void => {
      if (depth > 64) throw new Error("depth");
      space();
      const char = text[position++];
      if (char === "{" || char === "[") {
        const end = char === "{" ? "}" : "]", names = new Set<string>();
        space();
        while (text[position] !== end) {
          if (char === "{") {
            const name = string();
            if (names.has(name)) throw new Error("duplicate");
            names.add(name); space(); position++;
          }
          visit(depth + 1); space();
          if (text[position] !== ",") break;
          position++; space();
        }
        position++;
      } else if (char === '"') { position--; string(); }
      else { while (position < text.length && !/[\s,\]}]/.test(text[position]!)) position++; }
    };
    visit(0);
    return value;
  } catch { throw new ToolFailure("receipt", "json"); }
}

/** Persist replacement metadata before any journalled publication proceeds. */
export async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const file = await open(path, "wx", 0o600);
  try { await file.writeFile(JSON.stringify(value, null, 2) + "\n"); await file.sync(); }
  finally { await file.close(); }
}

/** Python and Explorer share this claim; abandoned claims require explicit recovery, never a timeout guess. */
export async function installationLock<T>(root: string, signal: AbortSignal | undefined, action: () => Promise<T>): Promise<T> {
  await prepareRoot(root);
  const path = join(root, ".eska-components.claim"), recovery = join(root, ".eska-components.recovering");
  const token = JSON.stringify({ schema_version: 1, pid: process.pid, nonce: randomBytes(16).toString("hex") });
  if (await lstat(recovery).catch(() => undefined)) throw new ToolFailure("busy", recovery);
  const file = await open(path, "wx", 0o600).catch(error => { throw new ToolFailure(error.code === "EEXIST" ? "busy" : "io", path); });
  const identity = await file.stat();
  try {
    await file.writeFile(token); await file.sync();
    if (await lstat(recovery).catch(() => undefined)) throw new ToolFailure("busy", recovery);
    assertCurrent(signal);
    return await action();
  } finally {
    await file.close();
    await removeOwnedClaim(path, identity.dev, identity.ino);
  }
}

/** Explicit recovery serializes claim removal; a live or unidentifiable owner is never evicted. */
export async function recoverAbandonedClaim(root: string): Promise<void> {
  await prepareRoot(root);
  const claim = join(root, ".eska-components.claim"), recovery = join(root, ".eska-components.recovering");
  const token = JSON.stringify({ schema_version: 1, pid: process.pid, nonce: randomBytes(16).toString("hex") });
  const file = await open(recovery, "wx", 0o600).catch(() => { throw new ToolFailure("busy", recovery); });
  const identity = await file.stat();
  try {
    await file.writeFile(token); await file.sync();
    if (!await lstat(claim).catch(error => { if (error.code === "ENOENT") return undefined; throw error; })) return;
    const owner = await readMetadata(claim, 1024);
    exactKeys(owner, ["schema_version", "pid", "nonce"]);
    if (owner.schema_version !== 1 || !Number.isSafeInteger(owner.pid) || (owner.pid as number) <= 0
      || typeof owner.nonce !== "string" || !/^[0-9a-f]{32}$/.test(owner.nonce)) throw new ToolFailure("busy", claim);
    let dead = false;
    try { process.kill(owner.pid as number, 0); }
    catch (error) { dead = (error as NodeJS.ErrnoException).code === "ESRCH"; }
    if (!dead) throw new ToolFailure("busy", claim);
    await rm(claim);
  } finally {
    await file.close();
    await removeOwnedClaim(recovery, identity.dev, identity.ino);
  }
}

/** An interrupted claim write can be removed by inode ownership without deleting a replacement claim. */
async function removeOwnedClaim(path: string, device: number, inode: number): Promise<void> {
  const info = await lstat(path).catch(error => { if (error.code === "ENOENT") return undefined; throw error; });
  if (info?.isFile() && info.dev === device && info.ino === inode) await rm(path);
}
