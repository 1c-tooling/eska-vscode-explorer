import type { Memento } from "vscode";
import type { ProjectTree, TreeEntry } from "./tree.js";

/** External reports/processings have object collections rather than configuration sections. */
export function supportsRootFilter(project: ProjectTree): boolean {
  return project.info.type === "configuration" || project.info.type === "extension";
}

/** Only authoritative empty root sections may disappear; unknown and error states remain visible. */
export function isHiddenRootSection(entry: TreeEntry, hideEmpty: boolean): boolean {
  return hideEmpty && supportsRootFilter(entry.project) && entry.node.rootSection && entry.node.state === "empty";
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
