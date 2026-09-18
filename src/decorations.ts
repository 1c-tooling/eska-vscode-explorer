import * as vscode from "vscode";
import { sep } from "node:path";
import { isRecord, isWirePath } from "./protocol.js";
import { nativePath, isFormPayload } from "./source.js";
import { relativeFile } from "./reveal.js";
import { message } from "./messages.js";
import { gitStatus, type GitStatus } from "./git-status.js";
import type { FormSource } from "./forms.js";
import type { MetadataTree, ProjectTree, TreeEntry } from "./tree.js";

// Read-only subset of https://github.com/microsoft/vscode/blob/main/extensions/git/src/api/git.d.ts.
interface Change { uri: vscode.Uri; originalUri: vscode.Uri; status: number }
interface Repository {
  state: { indexChanges: Change[]; workingTreeChanges: Change[]; mergeChanges: Change[];
    untrackedChanges?: Change[]; onDidChange: vscode.Event<void> };
}
interface GitApi { repositories: Repository[]; onDidOpenRepository: vscode.Event<Repository>; onDidCloseRepository: vscode.Event<Repository> }
interface GitExtension { enabled: boolean; onDidChangeEnablement: vscode.Event<boolean>; getAPI(version: 1): GitApi }
interface FileChange { path: string; status: GitStatus }
type Entry = TreeEntry | FormSource;
interface Snapshot { files: FileChange[]; names: Map<string, FileChange[]> }

/** Compare paths using the same host rules as source navigation. */
function comparable(value: string): string { return process.platform === "win32" ? value.toLowerCase() : value; }

/** Decorate only private tree URIs, never other explorers, tabs or language providers. */
export class GitDecorations implements vscode.FileDecorationProvider, vscode.Disposable {
  private readonly changed = new vscode.EventEmitter<vscode.Uri[] | undefined>();
  readonly onDidChangeFileDecorations = this.changed.event;
  private readonly subscriptions: vscode.Disposable[] = [];
  private apiSubscriptions: vscode.Disposable[] = [];
  private readonly repositories = new Map<Repository, vscode.Disposable>();
  private readonly entries = new Map<string, Entry>();
  private readonly snapshots = new Map<ProjectTree, Snapshot>();
  private results = new Map<string, Promise<vscode.FileDecoration | undefined>>();
  private api: GitApi | undefined;
  private tree: MetadataTree | undefined;
  private epoch = 0;
  private disposed = false;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private serial: Promise<unknown> = Promise.resolve();

  constructor() {
    this.subscriptions.push(vscode.window.registerFileDecorationProvider(this));
    this.subscriptions.push(vscode.workspace.onDidChangeConfiguration(event => {
      if (event.affectsConfiguration("git.decorations.enabled")) this.invalidate();
    }));
    void this.attach();
  }

  /** Git is optional; disabling it must not disable metadata navigation. */
  private async attach(): Promise<void> {
    try {
      const extension = vscode.extensions.getExtension<GitExtension>("vscode.git");
      if (!extension) return;
      const git = await extension.activate();
      if (this.disposed) return;
      const enable = (): void => {
        for (const subscription of this.apiSubscriptions) subscription.dispose();
        this.apiSubscriptions = [];
        for (const subscription of this.repositories.values()) subscription.dispose();
        this.repositories.clear();
        this.api = git.enabled ? git.getAPI(1) : undefined;
        if (this.api) {
          for (const repository of this.api.repositories) this.watch(repository);
          this.apiSubscriptions.push(this.api.onDidOpenRepository(repository => { this.watch(repository); this.invalidate(); }));
          this.apiSubscriptions.push(this.api.onDidCloseRepository(repository => {
            this.repositories.get(repository)?.dispose(); this.repositories.delete(repository); this.invalidate();
          }));
        }
        this.invalidate();
      };
      this.subscriptions.push(git.onDidChangeEnablement(enable));
      enable();
    } catch { /* Git unavailable: leave all custom decorations empty. */ }
  }

  /** Subscribe to Git's existing status refresh rather than starting another Git process. */
  private watch(repository: Repository): void {
    if (!this.repositories.has(repository)) this.repositories.set(repository, repository.state.onDidChange(() => this.invalidate()));
  }

  /** Drop obsolete identities when the connection changes. */
  setTree(tree: MetadataTree | undefined): void {
    if (tree !== this.tree) this.entries.clear();
    this.tree = tree;
    this.invalidate();
  }

  /** Coalesce Git and metadata events, and reject any already running stale result. */
  invalidate(): void {
    if (this.disposed) return;
    this.epoch++;
    this.snapshots.clear();
    this.results = new Map();
    clearTimeout(this.timer);
    this.timer = setTimeout(() => { this.changed.fire(undefined); }, 100);
  }

  /** Painting registers an identity only; no IO or backend request runs in getTreeItem. */
  resource(entry: Entry): vscode.Uri {
    const key = "owner" in entry ? `${entry.owner.key}:source:${entry.target}` : entry.key;
    this.entries.set(key, entry);
    return vscode.Uri.from({ scheme: "eska-decoration", path: "/" + encodeURIComponent(key) });
  }

  /** Resolve only requested visible decorations; serialize reads to protect the backend queue. */
  provideFileDecoration(uri: vscode.Uri): Promise<vscode.FileDecoration | undefined> | undefined {
    if (uri.scheme !== "eska-decoration" || !this.tree || !this.api || this.disposed
      || !vscode.workspace.getConfiguration("git").get<boolean>("decorations.enabled", true)) return undefined;
    const key = decodeURIComponent(uri.path.slice(1));
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    const cached = this.results.get(key);
    if (cached) return cached;
    const tree = this.tree;
    const epoch = this.epoch;
    const result = this.serial.then(async () => {
      if (epoch !== this.epoch || this.disposed) return undefined;
      try {
        const decoration = await this.resolve(tree, entry, epoch);
        return epoch === this.epoch && !this.disposed ? decoration : undefined;
      } catch { return undefined; } // A broken descriptor must remain navigable without decorations.
    });
    this.serial = result;
    this.results.set(key, result);
    return result;
  }

  /** Index only Git's changed paths once per project snapshot, never scan source directories. */
  private snapshot(project: ProjectTree): Snapshot {
    const cached = this.snapshots.get(project);
    if (cached) return cached;
    const files = new Map<string, FileChange>();
    const root = nativePath(project.info.sourcePath);
    for (const repository of this.api?.repositories ?? []) {
      const state = repository.state;
      for (const change of [...state.indexChanges, ...state.workingTreeChanges, ...(state.untrackedChanges ?? []), ...state.mergeChanges]) {
        const status = gitStatus(change.status);
        if (!status) continue;
        const uris = change.status === 3 || change.status === 10 ? [change.uri, change.originalUri] : [change.uri];
        for (const uri of uris) {
          if (uri.scheme !== "file") continue;
          const path = relativeFile(root, uri.fsPath);
          if (!path) continue;
          const key = comparable(path);
          const previous = files.get(key);
          if (!previous || previous.status.priority <= status.priority) files.set(key, { path: key, status });
        }
      }
    }
    const snapshot: Snapshot = { files: [...files.values()], names: new Map() };
    for (const file of snapshot.files) for (const name of new Set(file.path.split(sep).map(part => part.replace(/\.xml$/i, "")))) {
      const matches = snapshot.names.get(name) ?? [];
      matches.push(file); snapshot.names.set(name, matches);
    }
    this.snapshots.set(project, snapshot);
    return snapshot;
  }

  /** Use server-provided source paths for exact files and descriptor-owned directories. */
  private async resolve(tree: MetadataTree, entry: Entry, epoch: number): Promise<vscode.FileDecoration | undefined> {
    if (epoch !== this.epoch) return undefined;
    const owner = "owner" in entry ? entry.owner : entry;
    const snapshot = this.snapshot(owner.project);
    if (!snapshot.files.length) return undefined;
    if (!owner.node.parent) return this.descendant();
    if (!("owner" in entry) && owner.node.id.kind === "collection") {
      for (const child of await tree.children(owner)) {
        if (epoch !== this.epoch) return undefined;
        try { if (await this.resolve(tree, child, epoch)) return this.descendant(); }
        catch { /* One unavailable source must not hide changes in its siblings. */ }
      }
      return undefined;
    }
    const nameOwner = owner.node.id.kind === "module" ? tree.parent(tree.parent(owner) ?? owner) : owner;
    if (nameOwner?.node.parent && nameOwner.node.label.kind === "name" && !snapshot.names.has(comparable(nameOwner.node.label.text))) return undefined;
    const result = await tree.request(owner.project, "metadata/source", { node: owner.node.id });
    if (!Array.isArray(result.sources)) return undefined;
    const exact: GitStatus[] = [];
    let descendants = false;
    for (const source of result.sources) {
      if (!isRecord(source) || !isWirePath(source.path) || !isRecord(source.role)) continue;
      if ("owner" in entry && !(entry.target === "form" ? isFormPayload(source) : source.role.kind === "module" && source.role.role === "module")) continue;
      const path = comparable(nativePath(source.path));
      for (const change of snapshot.files) {
        if (change.path === path) exact.push(change.status);
        if (!("owner" in entry) && owner.node.id.kind === "object" && source.role.kind === "descriptor" && path.endsWith(".xml")
          && change.path.startsWith(path.slice(0, -4) + sep)) descendants = true;
      }
    }
    const status = exact.sort((a, b) => b.priority - a.priority)[0];
    return status ? new vscode.FileDecoration(status.badge, message(vscode.env.language, status.message), new vscode.ThemeColor(`gitDecoration.${status.color}`))
      : descendants ? this.descendant() : undefined;
  }

  /** Parent markers deliberately describe changed files, not a semantic change to every child. */
  private descendant(): vscode.FileDecoration {
    return new vscode.FileDecoration("•", message(vscode.env.language, "gitDescendants"), new vscode.ThemeColor("gitDecoration.modifiedResourceForeground"));
  }

  /** Stop listeners and queued work when the extension shuts down. */
  dispose(): void {
    this.disposed = true; this.epoch++;
    clearTimeout(this.timer);
    for (const subscription of this.subscriptions) subscription.dispose();
    for (const subscription of this.apiSubscriptions) subscription.dispose();
    for (const subscription of this.repositories.values()) subscription.dispose();
    this.repositories.clear(); this.entries.clear(); this.snapshots.clear(); this.results.clear();
    this.changed.dispose();
  }
}
