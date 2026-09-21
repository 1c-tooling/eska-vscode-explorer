import { Connection } from "./connection.js";
import { ExplorerError, isRecord, isToken, parseWorkspace, type ProjectInfo, type WorkspaceSession } from "./protocol.js";

export type NodeId = { kind: "object"; objectId: string }
  | { kind: "module"; owner: string; role: string }
  | { kind: "collection"; owner: string; collection: { kind: "metadata"; metadataKind: string }
    | { kind: "common" | "modules" | "unsupported" } };
export interface MetadataNode {
  id: NodeId;
  metadataKind?: string | null;
  parent: NodeId | null;
  label: { kind: "name"; text: string } | { kind: "key"; key: string; translations: Record<"ru-RU" | "en-US", string> };
  state: "empty" | "non_empty" | "unloaded" | "error";
  expandedByDefault: boolean;
  rootSection: boolean;
}
export interface ProjectTree {
  info: ProjectInfo;
  key: string;
  nodes: Map<string, TreeEntry>;
  root: TreeEntry | undefined;
  rootDirty: boolean;
}
export interface TreeEntry {
  key: string;
  project: ProjectTree;
  node: MetadataNode;
  children: TreeEntry[] | undefined;
  previousChildren: TreeEntry[];
  pending: Promise<TreeEntry[]> | undefined;
}

/** Canonical tuples ignore JSON property order and keep backend identities opaque. */
export function nodeKey(id: NodeId): string {
  if (id.kind === "object") return JSON.stringify([id.kind, id.objectId]);
  if (id.kind === "module") return JSON.stringify([id.kind, id.owner, id.role]);
  return JSON.stringify([id.kind, id.owner, id.collection.kind,
    id.collection.kind === "metadata" ? id.collection.metadataKind : null]);
}

/** Validate the discriminant before using untrusted identities as tree keys. */
export function isNodeId(value: unknown): value is NodeId {
  if (!isRecord(value)) return false;
  if (value.kind === "object") return typeof value.objectId === "string";
  if (typeof value.owner !== "string") return false;
  if (value.kind === "module") return typeof value.role === "string";
  if (value.kind !== "collection" || !isRecord(value.collection)) return false;
  const collection = value.collection;
  return collection.kind === "metadata" ? typeof collection.metadataKind === "string"
    : ["common", "modules", "unsupported"].includes(String(collection.kind));
}

/** Accept backend-supplied labels and schemas without a duplicate metadata catalog. */
export function parseNode(value: unknown): MetadataNode {
  if (!isRecord(value) || (value.metadataKind !== undefined && value.metadataKind !== null && typeof value.metadataKind !== "string")
    || !isNodeId(value.id) || !(value.parent === null || isNodeId(value.parent))
    || !isRecord(value.label) || typeof value.expandedByDefault !== "boolean"
    || typeof value.rootSection !== "boolean" || !["empty", "non_empty", "unloaded", "error"].includes(String(value.state))) {
    throw new ExplorerError("protocolInvalid");
  }
  const label = value.label;
  if (!(label.kind === "name" && typeof label.text === "string")
    && !(label.kind === "key" && typeof label.key === "string" && isRecord(label.translations)
      && typeof label.translations["ru-RU"] === "string" && typeof label.translations["en-US"] === "string")) {
    throw new ExplorerError("protocolInvalid");
  }
  return value as unknown as MetadataNode;
}

/** Read only the stable owner field; separators inside ObjectId have no client semantics. */
function owner(id: NodeId): string { return id.kind === "object" ? id.objectId : id.owner; }

/** Lazily cache unfiltered branches, retaining object references and IDs across local invalidations. */
export class MetadataTree {
  readonly projects: ProjectTree[];
  private disposed = false;
  private readonly subscription: { dispose(): void };

  constructor(readonly connection: Connection, readonly session: WorkspaceSession,
    private readonly changed: (entries: TreeEntry[] | undefined) => void,
    private readonly recover: (project: ProjectTree, reopen: boolean) => void) {
    this.projects = session.projects.map((info) => ({ info: { ...info },
      key: JSON.stringify([info.rootPath.encoding, info.rootPath.value, info.scope]),
      nodes: new Map(), root: undefined, rootDirty: true }));
    this.subscription = connection.onNotification((method, params) => {
      if (method === "metadata/changed") this.invalidated(params);
    });
  }

  /** Resolve only root summaries, never descend into object descriptors. */
  async roots(): Promise<TreeEntry[]> {
    return Promise.all(this.projects.map((project) => this.root(project)));
  }

  /** Keep a broken root independent from other workspace members. */
  async root(project: ProjectTree): Promise<TreeEntry> {
    if (!project.root || project.rootDirty) {
      const result = await this.request(project, "metadata/root");
      const node = parseNode(result.node);
      if (nodeKey(node.id) !== nodeKey(project.info.root) || node.parent !== null) throw new ExplorerError("protocolInvalid");
      project.root = this.upsert(project, node);
      project.rootDirty = false;
    }
    return project.root;
  }

  /** In-flight deduplication prevents repeated expansion requests for the same branch. */
  children(entry: TreeEntry): Promise<TreeEntry[]> {
    if (this.disposed || entry.project.nodes.get(nodeKey(entry.node.id)) !== entry) {
      return Promise.reject(new ExplorerError("obsolete"));
    }
    if (entry.children) return Promise.resolve(entry.children);
    if (entry.pending) return entry.pending;
    const pending = this.loadChildren(entry);
    entry.pending = pending;
    void pending.finally(() => { if (entry.pending === pending) entry.pending = undefined; }).catch(() => {});
    return pending;
  }

  /** Preserve server ordering and parent relationships, rejecting malformed sibling lists. */
  private async loadChildren(entry: TreeEntry): Promise<TreeEntry[]> {
    const result = await this.request(entry.project, "metadata/children", { node: entry.node.id, hideEmptyRootSections: false });
    if (entry.project.nodes.get(nodeKey(entry.node.id)) !== entry) throw new ExplorerError("obsolete");
    if (!Array.isArray(result.nodes)) throw new ExplorerError("protocolInvalid");
    const nodes = result.nodes.map(parseNode);
    const keys = new Set<string>();
    for (const node of nodes) {
      const key = nodeKey(node.id);
      if (!node.parent || nodeKey(node.parent) !== nodeKey(entry.node.id) || keys.has(key)) throw new ExplorerError("protocolInvalid");
      keys.add(key);
    }
    for (const old of entry.previousChildren) if (!keys.has(nodeKey(old.node.id))) this.prune(old);
    entry.children = nodes.map((node) => this.upsert(entry.project, node));
    entry.previousChildren = entry.children;
    // A completed request proves object emptiness; unloaded nodes must keep their expander.
    if (entry.node.id.kind === "object") {
      const state = nodes.length === 0 ? "empty" : "non_empty";
      if (entry.node.state !== state) {
        entry.node = { ...entry.node, state };
        this.changed([entry]);
      }
    }
    return entry.children;
  }

  /** Parent links are supplied by the backend, not reconstructed from object names. */
  parent(entry: TreeEntry): TreeEntry | undefined {
    return entry.node.parent ? entry.project.nodes.get(nodeKey(entry.node.parent)) : undefined;
  }

  /** Read requests may retry after an intervening change, but never loop indefinitely. */
  async request(project: ProjectTree, method: string, params: Record<string, unknown> = {}, signal?: AbortSignal): Promise<Record<string, unknown>> {
    for (let attempt = 0; attempt < 3; attempt++) {
      if (signal?.aborted) throw new ExplorerError("cancelled");
      if (this.disposed) throw new ExplorerError("obsolete");
      if (project.info.requiresReopen) throw new ExplorerError("obsolete");
      if (project.info.requiresRefresh && method !== "metadata/refresh") throw new ExplorerError("branchInvalid");
      const generation = project.info.generation;
      try {
        const result = await this.connection.request(this.session.sessionId, method,
          { ...params, projectId: project.info.projectId, generation }, signal);
        if (this.disposed) throw new ExplorerError("obsolete");
        if (!isRecord(result) || result.sessionId !== this.session.sessionId || result.projectId !== project.info.projectId
          || !isToken(result.generation) || !isToken(result.eventSequence)) throw new ExplorerError("protocolInvalid");
        if (BigInt(result.generation) < BigInt(project.info.generation)
          || BigInt(result.eventSequence) < BigInt(project.info.eventSequence)) continue;
        if (result.generation !== project.info.generation || result.eventSequence !== project.info.eventSequence) {
          // Missing an invalidation is a resync condition, never permission to reuse cached branches.
          await this.synchronize(project);
          this.recover(project, project.info.requiresReopen);
          throw new ExplorerError("sourceChanged");
        }
        return result;
      } catch (error) {
        if (error instanceof ExplorerError && error.domain === "stale_generation") {
          // An ordered event already invalidated this snapshot; retry without triggering another refresh.
          if (generation !== project.info.generation && !project.info.requiresRefresh && !project.info.requiresReopen) continue;
          await this.synchronize(project);
          if (method === "metadata/refresh") continue;
          this.recover(project, project.info.requiresReopen);
          throw new ExplorerError("sourceChanged");
        }
        if (error instanceof ExplorerError && (error.domain === "resync_required" || error.domain === "reopen_required")) {
          await this.synchronize(project);
          this.recover(project, project.info.requiresReopen);
        }
        throw error;
      }
    }
    throw new ExplorerError("sourceChanged");
  }

  /** Read authoritative tokens without a generation precondition after a lost invalidation. */
  private async synchronize(project: ProjectTree): Promise<void> {
    const snapshot = parseWorkspace(await this.connection.request(this.session.sessionId, "project/info"));
    if (this.disposed || snapshot.sessionId !== this.session.sessionId) throw new ExplorerError("obsolete");
    const info = snapshot.projects.find((info) => info.projectId === project.info.projectId);
    if (!info) throw new ExplorerError("obsolete");
    if (BigInt(info.generation) >= BigInt(project.info.generation) && BigInt(info.eventSequence) >= BigInt(project.info.eventSequence)) {
      Object.assign(project.info, info);
    }
    for (const entry of project.nodes.values()) entry.children = undefined;
    project.rootDirty = true;
    this.changed(undefined);
  }

  /** Refreshes produce their own ordered invalidation before their response. */
  async refresh(project: ProjectTree, entry?: TreeEntry): Promise<void> {
    await this.request(project, "metadata/refresh", { node: entry?.node.id ?? project.info.root });
  }

  /** Reuse node objects so VS Code keeps selection and expansion for untouched siblings. */
  private upsert(project: ProjectTree, node: MetadataNode): TreeEntry {
    const key = nodeKey(node.id);
    let entry = project.nodes.get(key);
    if (entry) {
      entry.node = node;
      // Empty branches have no expander: they will never load children again to prune old rows.
      if (node.state === "empty") {
        for (const child of entry.previousChildren) this.prune(child);
        entry.children = [];
        entry.previousChildren = entry.children;
      }
    }
    else {
      entry = { key: `${project.key}:${key}`, project, node, children: undefined, previousChildren: [], pending: undefined };
      project.nodes.set(key, entry);
    }
    return entry;
  }

  /** Removed subtrees cannot accumulate indefinitely during repeated external renames. */
  private prune(entry: TreeEntry): void {
    for (const child of entry.previousChildren) this.prune(child);
    entry.project.nodes.delete(nodeKey(entry.node.id));
  }

  /** Invalidate only affected owners and their immediate presentation parents. */
  private invalidated(value: unknown): void {
    if (!isRecord(value) || value.sessionId !== this.session.sessionId) return;
    const project = this.projects.find((candidate) => candidate.info.projectId === value.projectId);
    if (!project || !isToken(value.generation) || !isToken(value.eventSequence)
      || typeof value.requiresRefresh !== "boolean" || typeof value.requiresReopen !== "boolean"
      || !(value.affected === null || (Array.isArray(value.affected) && value.affected.every((id) => typeof id === "string")))) {
      throw new ExplorerError("protocolInvalid");
    }
    const info = project.info;
    if (BigInt(value.eventSequence) <= BigInt(info.eventSequence) || BigInt(value.generation) < BigInt(info.generation)) return;
    const gap = BigInt(value.eventSequence) !== BigInt(info.eventSequence) + 1n;
    Object.assign(info, { generation: value.generation, eventSequence: value.eventSequence,
      requiresRefresh: value.requiresRefresh, requiresReopen: value.requiresReopen });
    const affected = value.affected === null || gap ? null : new Set(value.affected as string[]);
    const roots = new Set<TreeEntry>();
    for (const entry of project.nodes.values()) {
      if (affected === null || affected.has(owner(entry.node.id))) {
        entry.children = undefined;
        // Keep pending promises: their generation checks retry after this event.
        const parent = this.parent(entry);
        if (parent) { parent.children = undefined; roots.add(parent); }
        else roots.add(entry);
      }
    }
    if (affected === null || affected.has(info.root.objectId)) project.rootDirty = true;
    // Refresh the highest affected presentation branches; unrelated projects stay untouched.
    const top = [...roots].filter((entry) => {
      let parent = this.parent(entry);
      while (parent) { if (roots.has(parent)) return false; parent = this.parent(parent); }
      return true;
    });
    this.changed(project.rootDirty ? undefined : top);
    if (gap || info.requiresRefresh || info.requiresReopen) this.recover(project, info.requiresReopen);
  }

  /** Stop accepting events before the connection is replaced or the view is disposed. */
  dispose(): void { this.disposed = true; this.subscription.dispose(); }
}
