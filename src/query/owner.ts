import * as vscode from "vscode";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { open } from "node:fs/promises";
import { ExplorerError, isRecord, isWirePath, type WirePath } from "../protocol.js";
import { existingSource, nativePath, isForm } from "../source.js";
import { nodeKey, type MetadataTree, type TreeEntry } from "../tree.js";

export interface XmlQueryOwner {
  entry: TreeEntry;
  source: WirePath;
  descriptor: WirePath;
  path: string;
  descriptorPath: string;
  descriptorSnapshot: string;
  bom: boolean;
  document: vscode.TextDocument;
}

/** Query candidates come from declared owner kinds, never a workspace-wide XML search. */
export function isXmlQueryOwner(entry: TreeEntry): boolean {
  return entry.node.id.kind === "object" && ["common-template", "template", "common-form", "form"].includes(entry.node.metadataKind ?? "");
}

/** Resolve both the exact payload and a descriptor seal without parsing XML again in TypeScript. */
export async function xmlQueryOwner(tree: MetadataTree, entry: TreeEntry): Promise<XmlQueryOwner | undefined> {
  if (!isXmlQueryOwner(entry)) return undefined;
  const result = await tree.request(entry.project, "metadata/source", { node: entry.node.id });
  if (!Array.isArray(result.sources)) throw new ExplorerError("protocolInvalid");
  const payloadName = isForm(entry) ? "Form.xml" : "Template.xml";
  const payloads = result.sources.filter(value => isRecord(value) && isRecord(value.role) && value.role.kind === "payload"
    && isWirePath(value.path) && nativePath(value.path).replaceAll("\\", "/").split("/").at(-1) === payloadName);
  if (payloads.length === 0) return undefined;
  const descriptors = result.sources.filter(value => isRecord(value) && isRecord(value.role) && value.role.kind === "descriptor" && isWirePath(value.path));
  if (payloads.length !== 1 || descriptors.length !== 1) throw new ExplorerError("protocolInvalid");
  const source = payloads[0]!.path as WirePath, descriptor = descriptors[0]!.path as WirePath;
  const path = await existingSource(entry.project.info.sourcePath, source);
  const descriptorPath = await existingSource(entry.project.info.sourcePath, descriptor);
  const descriptorSnapshot = await sourceHash(descriptorPath);
  const bom = await sourceBom(path);
  const document = await vscode.workspace.openTextDocument(vscode.Uri.file(path));
  if (entry.project.nodes.get(nodeKey(entry.node.id)) !== entry || document.isClosed) throw new ExplorerError("sourceChanged");
  return { entry, source, descriptor, path, descriptorPath, descriptorSnapshot, bom, document };
}

/** The editor strips an encoding signature; later saves must retain the exact original disk representation. */
async function sourceBom(path: string): Promise<boolean> {
  const file = await open(path, "r");
  try {
    const prefix = Buffer.alloc(3);
    const { bytesRead } = await file.read(prefix, 0, prefix.length, 0);
    return bytesRead === 3 && prefix.equals(Buffer.from([0xef, 0xbb, 0xbf]));
  } finally { await file.close(); }
}

/** Hash bounded fresh disk bytes independently from the owner's BOM-stripped editor buffer. */
export async function sourceHash(path: string): Promise<string> {
  const hash = createHash("sha256");
  let bytes = 0;
  for await (const chunk of createReadStream(path, { start: 0, end: 64 * 1024 * 1024 })) {
    const buffer = chunk as Buffer;
    bytes += buffer.length;
    if (bytes > 64 * 1024 * 1024) throw new ExplorerError("resourceLimit");
    hash.update(buffer);
  }
  return hash.digest("hex");
}
