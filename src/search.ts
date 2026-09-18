import { ExplorerError, isRecord } from "./protocol.js";
import { isNodeId, MetadataTree, nodeKey, type NodeId, type ProjectTree, type TreeEntry } from "./tree.js";

export interface IndexProgress {
  state: "not_started" | "building" | "cancelled" | "ready" | "incomplete";
  indexedObjects: number;
  pendingDescriptors: number;
  failedDescriptors: number;
}
export interface SearchHit {
  objectId: string;
  node: NodeId;
  metadataKind: string;
  name: string;
  synonyms: { language: string; content: string }[];
  ancestry: NodeId[];
  rank: string;
}
export interface SearchProject {
  project: ProjectTree;
  hits: SearchHit[];
  progress?: IndexProgress;
  truncated: boolean;
  error?: ExplorerError;
}
export interface SearchSnapshot { text: string; loading: boolean; projects: SearchProject[] }

/** Progress is advisory; invalid counters must never enter user-facing totals. */
export function parseProgress(value: unknown): IndexProgress {
  if (!isRecord(value) || typeof value.state !== "string" || !["not_started", "building", "cancelled", "ready", "incomplete"].includes(value.state)
    || ![value.indexedObjects, value.pendingDescriptors, value.failedDescriptors]
      .every((count) => typeof count === "number" && Number.isSafeInteger(count) && count >= 0)) {
    throw new ExplorerError("protocolInvalid");
  }
  return value as unknown as IndexProgress;
}

/** Validate backend identities and bounded hits without interpreting ObjectId path syntax. */
export function parseSearch(value: Record<string, unknown>, limit: number): Omit<SearchProject, "project"> {
  const progress = parseProgress(value.progress);
  if (!Array.isArray(value.hits) || value.hits.length > limit || typeof value.truncated !== "boolean") {
    throw new ExplorerError("protocolInvalid");
  }
  const seen = new Set<string>();
  for (const hit of value.hits) {
    if (!isRecord(hit) || typeof hit.objectId !== "string" || seen.has(hit.objectId)
      || !isNodeId(hit.node) || hit.node.kind !== "object" || hit.node.objectId !== hit.objectId
      || typeof hit.name !== "string" || typeof hit.metadataKind !== "string"
      || !Array.isArray(hit.synonyms) || !hit.synonyms.every((text) => isRecord(text)
        && typeof text.language === "string" && typeof text.content === "string")
      || !Array.isArray(hit.ancestry) || !hit.ancestry.length || hit.ancestry.length > 512
      || !hit.ancestry.every(isNodeId) || nodeKey(hit.ancestry[hit.ancestry.length - 1]!) !== nodeKey(hit.node)
      || typeof hit.rank !== "string"
      || !["exact_name", "exact_synonym", "prefix_name", "prefix_synonym", "substring_name", "substring_synonym"].includes(hit.rank)) {
      throw new ExplorerError("protocolInvalid");
    }
    seen.add(hit.objectId);
  }
  return { progress, hits: value.hits as SearchHit[], truncated: value.truncated };
}

/** Revalidate the selected identity, then load only its authoritative ancestry, never a full traversal. */
export async function revealHit(tree: MetadataTree, project: ProjectTree, hit: SearchHit, signal?: AbortSignal): Promise<TreeEntry> {
  const result = await tree.request(project, "metadata/reveal", { objectId: hit.objectId }, signal);
  const path = result.ancestry;
  if (!Array.isArray(path) || !path.length || path.length > 512 || !path.every(isNodeId)
    || nodeKey(path[0]!) !== nodeKey(project.info.root)
    || nodeKey(path[path.length - 1]!) !== nodeKey(hit.node)
    || new Set(path.map(nodeKey)).size !== path.length) throw new ExplorerError("protocolInvalid");
  let entry = await tree.root(project);
  for (const id of path.slice(1)) {
    if (signal?.aborted) throw new ExplorerError("cancelled");
    if (project.info.generation !== result.generation) throw new ExplorerError("sourceChanged");
    const child = (await tree.children(entry)).find((candidate) => nodeKey(candidate.node.id) === nodeKey(id));
    if (!child) throw new ExplorerError("sourceMissing");
    entry = child;
  }
  if (signal?.aborted) throw new ExplorerError("cancelled");
  if (project.info.generation !== result.generation) throw new ExplorerError("sourceChanged");
  return entry;
}

/** One serial, cancellable search loop coalesces typing and progress without accumulating requests. */
export class SearchSession {
  snapshot: SearchSnapshot;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private controller: AbortController | undefined;
  private revision = 0;
  private running = false;
  private pending = false;
  private disposed = false;
  private readonly subscription: { dispose(): void };

  constructor(private readonly tree: MetadataTree, private readonly changed: (snapshot: SearchSnapshot) => void,
    private readonly debounceMs = 250, private readonly progressMs = 500) {
    this.snapshot = { text: "", loading: false, projects: [] };
    this.subscription = tree.connection.onNotification((method, value) => {
      if (!isRecord(value) || value.sessionId !== tree.session.sessionId) return;
      const project = tree.projects.find((item) => item.info.projectId === value.projectId);
      if (!project || value.generation !== project.info.generation) return;
      if (method === "metadata/changed") this.setText(this.snapshot.text);
      else if (method === "metadata/indexProgress") this.schedule(this.progressMs);
    });
  }

  /** Clear obsolete hits immediately; only the final input after the debounce reaches the backend. */
  setText(text: string): void {
    if (this.disposed) return;
    this.revision++;
    this.controller?.abort();
    clearTimeout(this.timer);
    this.timer = undefined;
    this.snapshot = { text: text.trim(), loading: true, projects: [] };
    this.changed(this.snapshot);
    this.schedule(this.debounceMs);
  }

  /** A progress burst schedules one update instead of resetting the debounce indefinitely. */
  private schedule(delay: number): void {
    if (this.disposed) return;
    this.pending = true;
    this.timer ??= setTimeout(() => { this.timer = undefined; void this.run(); }, delay);
  }

  /** Index controls are idempotent by observed state; an existing ready index is reused. */
  private async run(): Promise<void> {
    if (this.running || this.disposed || !this.pending) return;
    this.pending = false;
    this.running = true;
    const revision = this.revision;
    const text = this.snapshot.text;
    const controller = new AbortController();
    this.controller = controller;
    const projects: SearchProject[] = [];
    try {
      for (const project of this.tree.projects) {
        if (controller.signal.aborted || this.disposed) break;
        let row: SearchProject;
        try {
          let progress = parseProgress((await this.tree.request(project, "metadata/index", { action: "status" }, controller.signal)).progress);
          if (progress.state === "not_started" || progress.state === "cancelled") {
            progress = parseProgress((await this.tree.request(project, "metadata/index",
              { action: progress.state === "not_started" ? "start" : "resume" }, controller.signal)).progress);
          }
          row = text ? { project, ...parseSearch(await this.tree.request(project, "metadata/search", { text, limit: 50 }, controller.signal), 50) }
            : { project, progress, hits: [], truncated: false };
        } catch (error) {
          if (controller.signal.aborted || this.disposed) break;
          row = { project, hits: [], truncated: false, error: error instanceof ExplorerError ? error : new ExplorerError("requestFailed") };
        }
        projects.push(row);
        if (revision === this.revision && !this.disposed) {
          this.snapshot = { text, loading: true, projects: [...projects] };
          this.changed(this.snapshot);
        }
      }
    } finally {
      this.running = false;
      this.controller = undefined;
      if (revision === this.revision && !this.disposed) {
        this.snapshot = { text, loading: false, projects };
        this.changed(this.snapshot);
      }
      if (this.pending && !this.timer) this.schedule(0);
    }
  }

  /** Closing the picker cancels reads, while an already started index can finish in the background. */
  dispose(): void {
    this.disposed = true;
    this.revision++;
    clearTimeout(this.timer);
    this.controller?.abort();
    this.subscription.dispose();
  }
}
