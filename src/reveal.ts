import { isAbsolute, relative, sep } from "node:path";
import { ExplorerError, isRecord, isWirePath } from "./protocol.js";
import { nativePath, directModuleRole, isForm, isFormPayload } from "./source.js";
import type { FormSource } from "./forms.js";
import type { MetadataTree, TreeEntry } from "./tree.js";

/** Keep comparisons consistent with the host filesystem's usual casing rules. */
function comparable(value: string): string { return process.platform === "win32" ? value.toLowerCase() : value; }

/** Reject sibling prefixes and paths outside the selected project. */
export function relativeFile(root: string, file: string): string | undefined {
  const path = relative(root, file);
  return path && !isAbsolute(path) && !path.split(sep).includes("..") ? path : undefined;
}

/** Use Designer XML names only as traversal hints; authoritative source mappings decide the match. */
export async function revealFile(tree: MetadataTree, file: string): Promise<TreeEntry | FormSource | undefined> {
  for (const project of tree.projects) {
    const path = relativeFile(nativePath(project.info.sourcePath), file);
    if (!path) continue;
    const targetPath = comparable(path);
    const names = new Set(path.split(sep).map(part => comparable(part.replace(/\.xml$/i, ""))));
    const generation = project.info.generation;
    const visited = new Set<string>();
    /** Follow virtual groups and matching names without indexing unrelated descriptors. */
    async function visit(entry: TreeEntry, depth: number): Promise<TreeEntry | FormSource | undefined> {
      if (project.info.generation !== generation) throw new ExplorerError("sourceChanged");
      if (depth > 128 || visited.has(entry.key)) return undefined;
      visited.add(entry.key);
      if (entry.node.id.kind === "module") return undefined;
      if (entry.node.id.kind === "object") {
        const result = await tree.request(project, "metadata/source", { node: entry.node.id });
        if (!Array.isArray(result.sources)) throw new ExplorerError("protocolInvalid");
        const source = result.sources.find(source => isRecord(source) && isWirePath(source.path)
          && comparable(nativePath(source.path)) === targetPath);
        if (isRecord(source) && isRecord(source.role)) {
          if (isForm(entry) && (isFormPayload(source) || source.role.kind === "module")) {
            return { owner: entry, target: source.role.kind === "module" ? "form-module" : "form" };
          }
          if (source.role.kind !== "module" || directModuleRole(entry) === source.role.role) return entry;
          const role = source.role.role;
          const groups = await tree.children(entry);
          const modules = groups.find(child => child.node.id.kind === "collection" && child.node.id.collection.kind === "modules");
          if (modules) return (await tree.children(modules)).find(child => child.node.id.kind === "module" && child.node.id.role === role);
          return undefined;
        }
      }
      for (const child of await tree.children(entry)) {
        if (child.node.id.kind === "collection" || (child.node.label.kind === "name" && names.has(comparable(child.node.label.text)))) {
          const found = await visit(child, depth + 1);
          if (found) return found;
        }
      }
      return undefined;
    }
    const found = await visit(await tree.root(project), 0);
    if (project.info.generation !== generation) throw new ExplorerError("sourceChanged");
    if (found) return found;
  }
  return undefined;
}
