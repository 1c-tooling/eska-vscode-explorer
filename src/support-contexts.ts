import * as vscode from 'vscode';
import { Connection, type ConnectionTarget } from './connection.js';
import { MetadataTree } from './tree.js';
import { ProjectWatcher, watchManifests } from './watch.js';

/** Protect additional VS Code folders without changing the Explorer's selected navigation context. */
export class SupportContexts {
  private revision = 0;
  private connections: Connection[] = [];
  private resources: vscode.Disposable[] = [];
  private trees: MetadataTree[] = [];
  private pending = new Set<string>();
  private cleanup: Promise<void> = Promise.resolve();

  constructor(private readonly version: string, private readonly publish: (trees: MetadataTree[], pending: string[]) => void,
    private readonly invalidate: () => void, private readonly log: (text: string) => void) {}

  /** Recreate folder-scoped sessions; identical UUIDs never share an object map. */
  async start(targets: ConnectionTarget[]): Promise<void> {
    const cleanup = this.stop();
    const revision = this.revision;
    await cleanup;
    if (revision !== this.revision) return;
    this.pending = new Set(targets.map(target => target.path));
    this.publish([...this.trees], [...this.pending]);
    for (const target of targets) {
      if (revision !== this.revision) return;
      let tree: MetadataTree | undefined;
      const resources: vscode.Disposable[] = [];
      const connection = new Connection(this.version, state => {
        if (revision !== this.revision) return;
        if (tree) { this.trees = this.trees.filter(value => value !== tree); tree.dispose(); tree = undefined; }
        for (const resource of resources.splice(0)) resource.dispose();
        this.pending.add(target.path);
        if (state.kind === 'ready' && state.supportPolicy) {
          this.pending.delete(target.path);
          tree = new MetadataTree(connection, state.session, this.invalidate, async (project, reopen) => {
            if (revision !== this.revision) return;
            if (reopen) await connection.connect(target);
            else await tree?.refresh(project).catch(error => this.log(String(error)));
          });
          this.trees.push(tree);
          for (const project of tree.projects) resources.push(new ProjectWatcher(tree, project, error => this.log(String(error))));
          resources.push(watchManifests(target.path, tree.projects, () => { void connection.connect(target); }));
        }
        this.publish([...this.trees], [...this.pending]);
      }, text => this.log(text));
      this.connections.push(connection);
      this.resources.push({ dispose: () => { for (const resource of resources.splice(0)) resource.dispose(); } });
      await connection.connect(target);
    }
  }

  /** Invalidate before awaiting process shutdown so replaced sessions cannot publish state. */
  stop(): Promise<void> {
    this.revision++;
    const connections = this.connections.splice(0);
    for (const resource of this.resources.splice(0)) resource.dispose();
    for (const tree of this.trees.splice(0)) tree.dispose();
    this.pending.clear();
    this.publish([], []);
    this.cleanup = Promise.all([this.cleanup, ...connections.map(connection => connection.dispose())]).then(() => {});
    return this.cleanup;
  }
}
