import { ExplorerError, isRecord } from "./protocol.js";
import { isFormPayload } from "./source.js";
import type { MetadataTree, TreeEntry } from "./tree.js";

/** UI-only source rows never introduce synthetic metadata IDs into the backend protocol. */
export interface FormSource {
  owner: TreeEntry;
  target: "form" | "form-module";
}

/** Cache form source rows against the lazy branch snapshot, preserving unrelated branches. */
export class FormSources {
  private readonly rows = new WeakMap<TreeEntry, { children: TreeEntry[]; pending: Promise<FormSource[]> }>();

  /** Read source availability only when the user expands a form, with concurrent request deduplication. */
  async children(tree: MetadataTree, owner: TreeEntry): Promise<FormSource[]> {
    const children = await tree.children(owner);
    const cached = this.rows.get(owner);
    if (cached?.children === children) return cached.pending;
    const pending = this.load(tree, owner);
    const row = { children, pending };
    this.rows.set(owner, row);
    try { return await pending; }
    catch (error) {
      if (this.rows.get(owner) === row) this.rows.delete(owner);
      throw error;
    }
  }

  /** Preserve Form-before-Module order and show only files confirmed by the backend. */
  private async load(tree: MetadataTree, owner: TreeEntry): Promise<FormSource[]> {
    const result = await tree.request(owner.project, "metadata/source", { node: owner.node.id });
    if (!Array.isArray(result.sources)) throw new ExplorerError("protocolInvalid");
    const rows: FormSource[] = [];
    if (result.sources.some(isFormPayload)) rows.push({ owner, target: "form" });
    if (result.sources.some(source => isRecord(source) && isRecord(source.role)
      && source.role.kind === "module" && source.role.role === "module")) rows.push({ owner, target: "form-module" });
    return rows;
  }
}
