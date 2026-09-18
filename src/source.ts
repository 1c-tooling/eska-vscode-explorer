import { readFile, realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { ExplorerError, isRecord, isWirePath, type WirePath } from "./protocol.js";
import { MetadataTree, type TreeEntry } from "./tree.js";

/** Decode only paths representable without loss on this extension host and in a VS Code URI. */
export function nativePath(path: WirePath): string {
  let value = path.value;
  try {
    if (path.encoding === "percent") {
      if (process.platform === "win32" || !/^(%[0-9a-fA-F]{2})+$/.test(value)) throw new Error();
      value = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true })
        .decode(Buffer.from(value.replaceAll("%", ""), "hex"));
    } else if (path.encoding === "utf-16-percent") {
      if (process.platform !== "win32" || !/^(%[0-9a-fA-F]{4})+$/.test(value)) throw new Error();
      value = value.replace(/%([0-9a-fA-F]{4})/g, (_, digits: string) => String.fromCharCode(parseInt(digits, 16)));
    }
    // encodeURIComponent rejects unpaired UTF-16 surrogates, which URI serialization would replace.
    encodeURIComponent(value);
    if (!value || value.includes("\0")) throw new Error();
    return value;
  } catch { throw new ExplorerError("unsupportedPath"); }
}

/** Check lexical components and real symlink targets before opening an existing regular file. */
export async function existingSource(root: WirePath, path: WirePath): Promise<string> {
  const base = nativePath(root);
  const child = nativePath(path);
  if (!isAbsolute(base) || isAbsolute(child) || child.split(process.platform === "win32" ? /[\\/]/ : /\//).some((part) => !part || part === "." || part === "..")
    || (process.platform === "win32" && child.includes(":"))) throw new ExplorerError("sourceMissing");
  try {
    const [canonicalBase, canonicalFile] = await Promise.all([realpath(base), realpath(resolve(base, child))]);
    const inside = relative(canonicalBase, canonicalFile);
    if (!inside || isAbsolute(inside) || inside.split(sep).includes("..") || !(await stat(canonicalFile)).isFile()) {
      throw new ExplorerError("sourceMissing");
    }
    return resolve(base, child);
  } catch { throw new ExplorerError("sourceMissing"); }
}

/** Translate backend UTF-8 offsets into VS Code UTF-16 offsets, excluding the editor's BOM. */
export function editorRange(bytes: Buffer, start: number, end: number): { text: string; start: number; end: number } {
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start || end > bytes.length) {
    throw new ExplorerError("protocolInvalid");
  }
  try {
    const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
    const text = decoder.decode(bytes);
    const from = decoder.decode(bytes.subarray(0, start)).length;
    const to = decoder.decode(bytes.subarray(0, end)).length;
    const bom = text.startsWith("\ufeff") ? 1 : 0;
    return { text: text.slice(bom), start: Math.max(0, from - bom), end: Math.max(0, to - bom) };
  } catch { throw new ExplorerError("sourceChanged"); }
}

export interface OpenSource { path: string; position?: { text: string; start: number; end: number } }

/** Identify common modules by the backend's typed parent, never by parsing opaque object IDs. */
export function isCommonModule(entry: TreeEntry): boolean {
  const parent = entry.node.parent;
  return entry.node.id.kind === "object" && parent?.kind === "collection"
    && parent.collection.kind === "metadata" && parent.collection.metadataKind === "common-module";
}

/** Object kinds come from the protocol; the parent fallback supports older common-module nodes. */
export function directModuleRole(entry: TreeEntry): string | undefined {
  if (entry.node.id.kind !== "object") return undefined;
  if (isCommonModule(entry)) return "module";
  switch (entry.node.metadataKind) {
    case "common-module": case "bot": case "web-service": case "http-service":
    case "web-socket-client": case "integration-service": return "module";
    case "common-command": case "command": return "command";
    case "recalculation": return "record-set";
    default: return undefined;
  }
}

/** Services and recalculations still expand their real metadata children while opening their code. */
export function isModuleLeaf(entry: TreeEntry): boolean {
  return directModuleRole(entry) !== undefined && !["web-service", "http-service", "integration-service", "recalculation"]
    .includes(entry.node.metadataKind ?? "");
}

/** Managed and common forms share the same two source actions. */
export function isForm(entry: TreeEntry): boolean {
  return entry.node.id.kind === "object" && ["form", "common-form"].includes(entry.node.metadataKind ?? "");
}

/** A form XML payload is distinct from its metadata descriptor and from a binary form. */
export function isFormPayload(source: unknown): boolean {
  return isRecord(source) && isRecord(source.role) && source.role.kind === "payload"
    && isWirePath(source.path) && nativePath(source.path).replaceAll("\\", "/").split("/").at(-1) === "Form.xml";
}

export type SourceTarget = "default" | "xml" | "form" | "form-module";

/** Request exact source mappings; virtual groups intentionally do not open an editor. */
export async function resolveSource(tree: MetadataTree, entry: TreeEntry, target: SourceTarget = "default"): Promise<OpenSource> {
  const id = entry.node.id;
  if (id.kind === "collection") throw new ExplorerError("sourceMissing");
  const moduleRole = id.kind === "module" ? id.role : target === "form-module" ? "module"
    : target === "default" ? directModuleRole(entry) : undefined;
  if ((target === "form" || target === "form-module") && !isForm(entry)) throw new ExplorerError("sourceMissing");
  const result = await tree.request(entry.project, "metadata/source", { node: id });
  const generation = entry.project.info.generation;
  const event = entry.project.info.eventSequence;
  if (!Array.isArray(result.sources)) throw new ExplorerError("protocolInvalid");
  const candidates = result.sources.filter((source) => isRecord(source) && isRecord(source.role)
    && (target === "form" ? isFormPayload(source) : moduleRole !== undefined
      ? source.role.kind === "module" && source.role.role === moduleRole : source.role.kind === "descriptor"));
  if (candidates.length !== 1 || !isWirePath(candidates[0].path)) throw new ExplorerError("sourceMissing");
  const path = await existingSource(entry.project.info.sourcePath, candidates[0].path);
  if (moduleRole !== undefined || id.kind === "module" || target === "form") return { path };
  // Reading only the selected descriptor gives byte-exact positions without parsing XML in the client.
  const before = await readFile(path);
  const properties = await tree.request(entry.project, "metadata/properties", { objectId: id.objectId });
  if (!Array.isArray(properties.properties)) throw new ExplorerError("protocolInvalid");
  const names = properties.properties.filter((property) => isRecord(property) && isRecord(property.key)
    && property.key.namespace === (entry.node.metadataKind === "predefined-item" ? "http://v8.1c.ru/8.3/xcf/predef" : "http://v8.1c.ru/8.3/MDClasses") && property.key.name === "Name");
  if (names.length !== 1 || !isRecord(names[0].range)
    || typeof names[0].range.start !== "number" || typeof names[0].range.end !== "number") throw new ExplorerError("protocolInvalid");
  if (!before.equals(await readFile(path)) || generation !== entry.project.info.generation || event !== entry.project.info.eventSequence) {
    throw new ExplorerError("sourceChanged");
  }
  return { path, position: editorRange(before, names[0].range.start, names[0].range.end) };
}
