import type { Memento } from "vscode";
import type { ProjectTree, TreeEntry } from "./tree.js";

export type SortOrder = "original" | "alphabetical";
const collators = {
  "ru-RU": new Intl.Collator("ru-RU", { sensitivity: "base", numeric: true }),
  "en-US": new Intl.Collator("en-US", { sensitivity: "base", numeric: true }),
};

/** Store presentation preferences by stable project identity, never by backend session ID. */
export class ProjectSorting {
  constructor(private readonly state: Pick<Memento, "get" | "update">) {}

  /** Missing or unrecognized settings preserve the backend's original order. */
  order(project: ProjectTree): SortOrder {
    return this.state.get<unknown>(`metadataSort:${project.key}`) === "alphabetical" ? "alphabetical" : "original";
  }

  /** Returning to the original order removes the workspace override. */
  async set(project: ProjectTree, order: SortOrder): Promise<void> {
    await this.state.update(`metadataSort:${project.key}`, order === "alphabetical" ? order : undefined);
  }

  /** Sort every metadata row by its displayed label without mutating backend arrays. */
  children(project: ProjectTree, entries: TreeEntry[], language: "ru-RU" | "en-US"): TreeEntry[] {
    return this.rows(project, entries, language, entry => entry.node.label.kind === "name"
      ? entry.node.label.text : entry.node.label.translations[language]);
  }

  /** Apply the same ordering to synthetic metadata rows such as form sources. */
  rows<T>(project: ProjectTree, entries: T[], language: "ru-RU" | "en-US", label: (entry: T) => string): T[] {
    if (this.order(project) === "original") return entries;
    return [...entries].sort((left, right) => collators[language].compare(label(left), label(right)));
  }
}
