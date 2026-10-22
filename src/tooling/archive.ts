import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fromBuffer, type Entry, type ZipFile } from "yauzl";
import { ToolFailure, assertCurrent, exactKeys, projectContract, type NativeTarget, type ProjectContract } from "./contracts.js";
import { checksum, relativePath, strictJson } from "./files.js";

export interface Payload { path: string; sha256: string; size: number; executable: boolean }
export interface ProjectPackage {
  schema_version: 1; tool: "eska-project"; version: string; target: NativeTarget; contract: ProjectContract; files: Payload[];
}
export const MAX_ARCHIVE = 512 * 1024 * 1024;
const MAX_UNPACKED = 2 * 1024 * 1024 * 1024;

/** The producer and both installer frontends share the same fixed executable/notice namespace. */
export function projectPackage(value: unknown, target?: NativeTarget): ProjectPackage {
  exactKeys(value, ["schema_version", "tool", "version", "target", "contract", "files"]);
  const contract = projectContract(value.contract, target);
  if (value.schema_version !== 1 || value.tool !== "eska-project" || value.version !== contract.version
    || value.target !== contract.target || !Array.isArray(value.files) || value.files.length < 2 || value.files.length > 8192) {
    throw new ToolFailure("archive", "package");
  }
  const binary = `bin/eska-project${contract.target.includes("windows") ? ".exe" : ""}`;
  const names = new Set<string>(); let size = 0;
  const files: Payload[] = value.files.map(item => {
    exactKeys(item, ["path", "sha256", "size", "executable"]);
    const path = relativePath(item.path);
    const canonical = path.toUpperCase().toLowerCase();
    if (names.has(canonical) || (path !== binary && !path.startsWith("licenses/"))
      || !Number.isSafeInteger(item.size) || (item.size as number) < 0 || (item.size as number) > MAX_UNPACKED
      || item.executable !== (path === binary)) throw new ToolFailure("archive", path);
    names.add(canonical); size += item.size as number;
    return { path, sha256: checksum(item.sha256), size: item.size as number, executable: path === binary };
  });
  if (!names.has(binary) || !names.has("licenses/license") || size > MAX_UNPACKED) throw new ToolFailure("archive", "payloads");
  return { schema_version: 1, tool: "eska-project", version: contract.version, target: contract.target, contract, files };
}

/** Open a lazy, bounded ZIP without extracting archive-chosen filesystem paths. */
async function openZip(data: Buffer): Promise<ZipFile> {
  return new Promise((resolve, reject) => fromBuffer(data, { lazyEntries: true, autoClose: false, strictFileNames: true }, (error, zip) => {
    if (error || !zip) reject(new ToolFailure("archive", "zip")); else resolve(zip);
  }));
}

/** Enumerate all entries before extraction; links, directories, encrypted and duplicate entries are rejected. */
async function entries(zip: ZipFile): Promise<Map<string, Entry>> {
  return new Promise((resolve, reject) => {
    const result = new Map<string, Entry>();
    zip.on("error", reject);
    zip.on("end", () => resolve(result));
    zip.on("entry", (entry: Entry) => {
      const mode = (entry.externalFileAttributes >>> 16) & 0o170000;
      if (result.size >= 8193 || result.has(entry.fileName) || entry.fileName.endsWith("/") || (entry.generalPurposeBitFlag & 1)
        || ![0, 8].includes(entry.compressionMethod) || ![0, 0o100000].includes(mode)) {
        reject(new ToolFailure("archive", "entry")); return;
      }
      result.set(entry.fileName, entry); zip.readEntry();
    });
    zip.readEntry();
  });
}

/** Yauzl validates actual uncompressed lengths; payload SHA-256 additionally verifies every extracted byte. */
async function stream(zip: ZipFile, entry: Entry): Promise<NodeJS.ReadableStream & AsyncIterable<Buffer>> {
  return new Promise((resolve, reject) => zip.openReadStream(entry, (error, input) => {
    if (error || !input) reject(new ToolFailure("archive", "stream")); else resolve(input);
  }));
}

/** Validate the full package and extract regular declared files into an exclusively owned staging directory. */
export async function unpackProject(data: Buffer, root: string, target: NativeTarget, signal?: AbortSignal): Promise<ProjectPackage> {
  if (data.length > MAX_ARCHIVE) throw new ToolFailure("archive", "size");
  const zip = await openZip(data);
  try {
    const list = await entries(zip), manifest = list.get("package.json");
    if (!manifest || manifest.uncompressedSize > 4 * 1024 * 1024) throw new ToolFailure("archive", "manifest");
    const chunks: Buffer[] = [];
    for await (const chunk of await stream(zip, manifest)) { assertCurrent(signal); chunks.push(chunk); }
    const value = projectPackage(strictJson(Buffer.concat(chunks)), target);
    if (list.size !== value.files.length + 1) throw new ToolFailure("archive", "members");
    for (const item of value.files) {
      assertCurrent(signal);
      const entry = list.get(item.path);
      if (!entry || entry.uncompressedSize !== item.size) throw new ToolFailure("archive", item.path);
      const path = join(root, item.path), hash = createHash("sha256"); let bytes = 0;
      await mkdir(dirname(path), { recursive: true });
      const verify = new Transform({ transform(chunk: Buffer, _encoding, callback) {
        bytes += chunk.length; hash.update(chunk);
        callback(bytes > item.size ? new ToolFailure("archive", "size") : null, chunk);
      } });
      await pipeline(await stream(zip, entry), verify, createWriteStream(path, { flags: "wx", mode: item.executable ? 0o755 : 0o644 }), { ...(signal ? { signal } : {}) });
      if (bytes !== item.size || hash.digest("hex") !== item.sha256) throw new ToolFailure("checksum", item.path);
    }
    return value;
  } catch (error) {
    assertCurrent(signal);
    throw error instanceof ToolFailure ? error : new ToolFailure("archive", "zip", { cause: error });
  } finally { zip.close(); }
}
