import { isAbsolute, relative, sep } from "node:path";
import { ExplorerError, isRecord, isWirePath } from "./protocol.js";
import { nativePath, directModuleRole, isForm, isFormPayload } from "./source.js";
import type { FormSource } from "./forms.js";
import { nodeKey, type MetadataTree, type TreeEntry } from "./tree.js";

/** Reject sibling prefixes and paths outside the selected project. */
export function relativeFile(root: string, file: string): string | undefined {
  const path = relative(root, file);
  return path && !isAbsolute(path) && !path.split(sep).includes("..") ? path : undefined;
}

/** ESKA resolves declared ownership and ancestry; the adapter selects only the corresponding UI row. */
export async function revealFile(tree: MetadataTree, file: string): Promise<TreeEntry | FormSource | undefined> {
  for (const project of tree.projects) {
    const path = relativeFile(nativePath(project.info.sourcePath), file);
    if (!path) continue;
    const state = tree.connection.state;
    if (state.kind !== "ready" || !state.sourceNavigation) throw new ExplorerError("incompatible");
    const result = await tree.request(project, "metadata/revealSource", { path: { value: path, encoding: "utf-8" } });
    if (result.source === null && Array.isArray(result.nodes) && !result.nodes.length) continue;
    if (!isRecord(result.source) || !isWirePath(result.source.path) || !isRecord(result.source.role)
      || nativePath(result.source.path) !== path || !["descriptor", "module", "payload"].includes(String(result.source.role.kind))) throw new ExplorerError("protocolInvalid");
    const entry = tree.acceptAncestry(project, result.nodes);
    if (result.source.role.kind === "module" ? entry.node.id.kind !== "module" || result.source.role.role !== entry.node.id.role
      : entry.node.id.kind !== "object") throw new ExplorerError("protocolInvalid");
    const owner = entry.node.id.kind === "module" ? project.nodes.get(nodeKey({ kind: "object", objectId: entry.node.id.owner })) : entry;
    if (!owner || owner.node.id.kind !== "object") throw new ExplorerError("protocolInvalid");
    if (isForm(owner) && (isFormPayload(result.source) || entry.node.id.kind === "module")) {
      return { owner, target: entry.node.id.kind === "module" ? "form-module" : "form" };
    }
    return entry.node.id.kind === "module" && directModuleRole(owner) === entry.node.id.role ? owner : entry;
  }
  return undefined;
}
