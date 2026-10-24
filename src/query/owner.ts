import * as vscode from "vscode";
import { configuredReadOnly } from "../editor-policy.js";
import { ExplorerError, isRecord, isWirePath, type WirePath } from "../protocol.js";
import { revealFile } from "../reveal.js";
import { existingSource, nativePath, isForm } from "../source.js";
import { nodeKey, type MetadataTree, type TreeEntry } from "../tree.js";

export interface QueryOwnerView {
  entry: TreeEntry;
  source: WirePath;
  path: string;
  userReadOnly: boolean;
  document: vscode.TextDocument;
}

/** Query candidates come from declared owner kinds, never a workspace-wide XML search. */
export function isXmlQueryOwner(entry: TreeEntry): boolean {
  return entry.node.id.kind === "object" && ["common-template", "template", "common-form", "form"].includes(entry.node.metadataKind ?? "");
}

/** Locate the native view from backend source roles; ESKA owns descriptor, disk and permission checks. */
export async function xmlQueryOwner(tree: MetadataTree, entry: TreeEntry): Promise<QueryOwnerView | undefined> {
  if (!isXmlQueryOwner(entry)) return undefined;
  const result = await tree.request(entry.project, "metadata/source", { node: entry.node.id });
  if (!Array.isArray(result.sources)) throw new ExplorerError("protocolInvalid");
  const payloadName = isForm(entry) ? "Form.xml" : "Template.xml";
  const payloads = result.sources.filter(value => isRecord(value) && isRecord(value.role) && value.role.kind === "payload"
    && isWirePath(value.path) && nativePath(value.path).replaceAll("\\", "/").split("/").at(-1) === payloadName);
  if (payloads.length === 0) return undefined;
  if (payloads.length !== 1) throw new ExplorerError("protocolInvalid");
  const source = payloads[0]!.path as WirePath;
  const path = await existingSource(entry.project.info.sourcePath, source);
  const document = await vscode.workspace.openTextDocument(vscode.Uri.file(path));
  const userReadOnly = await nativeReadOnly(document);
  if (entry.project.nodes.get(nodeKey(entry.node.id)) !== entry || document.isClosed) throw new ExplorerError("sourceChanged");
  return { entry, source, path, userReadOnly, document };
}

/** XML editing reports provider restrictions and never changes the user's native session-readonly override. */
export async function nativeReadOnly(document: vscode.TextDocument): Promise<boolean> {
  const stat = await vscode.workspace.fs.stat(document.uri);
  return stat.permissions === vscode.FilePermission.Readonly || configuredReadOnly(document);
}

/** Native tabs retain dirty state when a concurrent save notification clears the extension-host document flag. */
export function nativeDirty(document: vscode.TextDocument): boolean {
  const tabs = vscode.window.tabGroups.all.flatMap(group => group.tabs).filter(tab => tab.input instanceof vscode.TabInputText
    && tab.input.uri.toString() === document.uri.toString());
  return tabs.length ? tabs.some(tab => tab.isDirty) : document.isDirty;
}

/** Resolve the active module through backend source roles; the adapter never infers a BSL owner from its filename. */
export async function bslQueryOwner(tree: MetadataTree, document: vscode.TextDocument): Promise<QueryOwnerView> {
  const version = document.version;
  const revealed = await revealFile(tree, document.uri.fsPath);
  if (!revealed) throw new ExplorerError("sourceMissing");
  const entry = "target" in revealed ? revealed.owner : revealed;
  const result = await tree.request(entry.project, "metadata/source", { node: entry.node.id });
  if (!Array.isArray(result.sources)) throw new ExplorerError("protocolInvalid");
  for (const value of result.sources) {
    if (!isRecord(value) || !isRecord(value.role) || value.role.kind !== "module" || !isWirePath(value.path)) continue;
    const path = await existingSource(entry.project.info.sourcePath, value.path);
    if (vscode.Uri.file(path).toString() !== document.uri.toString()) continue;
    const userReadOnly = await nativeReadOnly(document);
    if (document.isClosed || document.version !== version) throw new ExplorerError("sourceChanged");
    return { entry, source: value.path, path, userReadOnly, document };
  }
  throw new ExplorerError("sourceMissing");
}
