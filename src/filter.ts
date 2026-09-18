import type { Memento } from "vscode";
import type { ProjectTree, TreeEntry } from "./tree.js";

/** External reports/processings have object collections rather than configuration sections. */
export function supportsRootFilter(project: ProjectTree): boolean {
  return project.info.type === "configuration" || project.info.type === "extension";
}

/** Hide proven empty root sections and immediate Common sections, never object internals. */
export function isHiddenSection(entry: TreeEntry, hideEmpty: boolean): boolean {
  if (!hideEmpty || !supportsRootFilter(entry.project) || entry.node.state !== "empty") return false;
  const { id, parent, rootSection } = entry.node;
  const commonSection = id.kind === "collection" && id.collection.kind === "metadata"
    && parent?.kind === "collection" && parent.collection.kind === "common" && id.owner === parent.owner;
  return rootSection || commonSection;
}

/** Persist explicit project choices in this editor workspace, separately from the configured default. */
export class ProjectFilters {
  constructor(private readonly state: Pick<Memento, "get" | "update">) {}

  /** Stable project keys survive backend restarts; session/project IDs deliberately do not participate. */
  enabled(project: ProjectTree, fallback: boolean): boolean {
    const value = this.state.get<unknown>(`rootFilter:${project.key}`);
    return typeof value === "boolean" ? value : fallback;
  }

  /** Undefined restores inheritance from the user/workspace/folder setting. */
  async set(project: ProjectTree, value: boolean | undefined): Promise<void> {
    await this.state.update(`rootFilter:${project.key}`, value);
  }
}
