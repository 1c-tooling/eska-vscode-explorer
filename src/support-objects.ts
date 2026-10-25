import { ExplorerError, isRecord } from './protocol.js';
import type { MetadataTree, ProjectTree } from './tree.js';

export type SupportState = 'locked' | 'editableWithSupport' | 'unrestricted' | 'unknown';
export interface ObjectPolicy { objectId: string; uuid: string; state: SupportState; reason: string }
export interface ObjectSnapshot {
  generation: string; eventSequence: string; objects: Map<string, ObjectPolicy>; diagnostics: string[];
}
interface Pending { tree: MetadataTree; ids: Set<string> }

/** Validate a complete response before exposing any object policy to the UI. */
export function objectPolicies(value: unknown, ids: readonly string[]): ObjectPolicy[] {
  if (!Array.isArray(value) || value.length !== ids.length) throw new ExplorerError('protocolInvalid');
  return value.map((item, index) => {
    if (!isRecord(item) || item.objectId !== ids[index] || typeof item.uuid !== 'string' || typeof item.reason !== 'string'
      || !['locked', 'editableWithSupport', 'unrestricted', 'unknown'].includes(String(item.state))) throw new ExplorerError('protocolInvalid');
    return item as unknown as ObjectPolicy;
  });
}

/** Coalesce painted identities into bounded backend reads, independently of native file-protection writes. */
export class SupportObjectQueue {
  private readonly pending = new Map<ProjectTree, Pending>();
  private readonly requested = new Map<ProjectTree, Set<string>>();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private running: Promise<void> | undefined;
  private epoch = 0;
  private stopped = false;

  constructor(private readonly publish: (project: ProjectTree, snapshot: ObjectSnapshot) => void,
    private readonly failure: (error: unknown) => void) {}

  /** Module and object rows share the same opaque owner identity and one request. */
  enqueue(tree: MetadataTree, project: ProjectTree, id: string): void {
    if (this.stopped) return;
    const requested = this.requested.get(project) ?? new Set<string>();
    if (requested.has(id)) return;
    requested.add(id); this.requested.set(project, requested);
    const pending = this.pending.get(project) ?? { tree, ids: new Set<string>() };
    pending.ids.add(id); this.pending.set(project, pending);
    this.schedule();
  }

  /** Support events invalidate both queued identities and already transmitted replies. */
  invalidate(): void {
    this.epoch++;
    this.pending.clear(); this.requested.clear();
    clearTimeout(this.timer); this.timer = undefined;
  }

  /** A fixed next-turn flush cannot be postponed indefinitely by more painted rows. */
  private schedule(): void {
    if (this.stopped || this.running || this.timer || !this.pending.size) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.running = this.flush().finally(() => { this.running = undefined; this.schedule(); });
    }, 0);
  }

  /** Publish every completed batch immediately and yield between batches for interactive file requests. */
  private async flush(): Promise<void> {
    const epoch = this.epoch;
    while (!this.stopped && epoch === this.epoch && this.pending.size) {
      const [project, pending] = this.pending.entries().next().value!;
      const ids = [...pending.ids].slice(0, 128);
      for (const id of ids) pending.ids.delete(id);
      if (!pending.ids.size) this.pending.delete(project);
      try {
        const result = await pending.tree.request(project, 'metadata/supportObjects', { objectIds: ids });
        if (this.stopped || epoch !== this.epoch) return;
        const objects = objectPolicies(result.objects, ids);
        if (!Array.isArray(result.diagnostics) || result.diagnostics.some(value => typeof value !== 'string')) throw new ExplorerError('protocolInvalid');
        this.publish(project, { generation: project.info.generation, eventSequence: project.info.eventSequence,
          objects: new Map(objects.map(object => [object.objectId, object])), diagnostics: result.diagnostics });
      } catch (error) {
        if (!this.stopped && epoch === this.epoch) this.failure(error);
      }
      if (this.pending.size) await new Promise(resolve => setTimeout(resolve, 0));
    }
  }

  /** Stop publishing before waiting for an in-flight bounded transport request. */
  async shutdown(): Promise<void> {
    this.stopped = true; this.invalidate();
    await this.running;
  }
}
