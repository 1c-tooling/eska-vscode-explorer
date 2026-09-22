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

  /** Sort visible object slots only; preserve virtual sections, module roles and cached arrays. */
  children(project: ProjectTree, entries: TreeEntry[], language: "ru-RU" | "en-US"): TreeEntry[] {
    if (this.order(project) === "original") return entries;
    const objects = entries.filter(entry => entry.node.id.kind === "object");
    const label = (entry: TreeEntry): string => entry.node.label.kind === "name"
      ? entry.node.label.text : entry.node.label.translations[language];
    objects.sort((left, right) => collators[language].compare(label(left), label(right)));
    let index = 0;
    return entries.map(entry => entry.node.id.kind === "object" ? objects[index++]! : entry);
  }
}
