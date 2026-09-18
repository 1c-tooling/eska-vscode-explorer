import { readdir, realpath, stat } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { relativeFile } from "./reveal.js";
import { nativePath } from "./source.js";
import type { ProjectTree } from "./tree.js";

export type FileGroupKind = "settings" | "documentation" | "other";
export interface FileScope {
  path: string;
  project: ProjectTree | undefined;
  groups: FileGroup[];
}
export interface FileGroup { fileKind: "group"; key: string; kind: FileGroupKind; scope: FileScope }
export interface FileEntry {
  fileKind: "entry";
  key: string;
  path: string;
  directory: boolean;
  link: boolean;
  parent: FileGroup | FileEntry;
}
export type WorkspaceEntry = FileGroup | FileEntry;
interface DirectoryEntry { name: string; directory: boolean; link: boolean }
interface DirectorySnapshot { real: string; entries: DirectoryEntry[] }
export type WatchDirectory = (path: string, changed: () => void) => { dispose(): void };

/** Assign only immediate scope files to categories; descendants retain their physical hierarchy. */
export function fileCategory(name: string, directory: boolean): FileGroupKind {
  if (directory) return "other";
  if (["eska.toml", ".gitignore"].includes(name)) return "settings";
  if (/^README(?:[.-][\w-]+)?\.md$/i.test(name)) return "documentation";
  return "other";
}

/** Overlay filesystem navigation on backend-owned project paths without parsing TOML or XML. */
export class WorkspaceFiles {
  readonly scopes: FileScope[];
  private readonly listings = new Map<string, Promise<DirectorySnapshot>>();
  private readonly watchers = new Map<string, { dispose(): void }>();
  private disposed = false;

  constructor(projects: readonly ProjectTree[], selectedPath: string,
    private readonly watch: WatchDirectory,
    private readonly changed: (entry: WorkspaceEntry | ProjectTree | undefined) => void) {
    const selected = resolve(selectedPath);
    const shared = projects.some(project => project.info.scope.kind === "member")
      && projects.every(project => relativeFile(selected, nativePath(project.info.rootPath)) !== undefined);
    this.scopes = projects.map(project => this.scope(nativePath(project.info.rootPath), project));
    if (shared) this.scopes.push(this.scope(selected, undefined));
  }

  /** Stable synthetic IDs are independent of translated labels and metadata generations. */
  private scope(path: string, project: ProjectTree | undefined): FileScope {
    const scope: FileScope = { path, project, groups: [] };
    const kinds: FileGroupKind[] = ["settings", "documentation", "other"];
    scope.groups = kinds.map(kind => ({ fileKind: "group", key: `files:${path}:${kind}`, kind, scope }));
    return scope;
  }

  /** Never list a connected project's source directory or another member twice. */
  private excluded(path: string, scope: FileScope): boolean {
    return this.scopes.some(other => other.project && (
      path === nativePath(other.project.info.sourcePath)
      || (other !== scope && path === other.path)));
  }

  /** Watch only directories requested by the user, avoiding recursive watchers over build and Git internals. */
  private listing(path: string, owner: WorkspaceEntry | ProjectTree | undefined): Promise<DirectorySnapshot> {
    if (this.disposed) return Promise.reject(new Error("Disposed workspace files"));
    const cached = this.listings.get(path);
    if (cached) return cached;
    if (!this.watchers.has(path)) this.watchers.set(path, this.watch(path, () => this.invalidate(path, owner)));
    const pending = this.readDirectory(path);
    this.listings.set(path, pending);
    void pending.catch(() => { if (this.listings.get(path) === pending) this.listings.delete(path); });
    return pending;
  }

  /** Ignore delayed create events already reflected in a snapshot, preserving selection on unrelated branches. */
  private async invalidate(path: string, owner: WorkspaceEntry | ProjectTree | undefined): Promise<void> {
    const previous = this.listings.get(path);
    try {
      const [before, after] = await Promise.all([previous, this.readDirectory(path)]);
      if (this.disposed || this.listings.get(path) !== previous) return;
      this.listings.set(path, Promise.resolve(after));
      if (before && before.real === after.real && JSON.stringify(before.entries) === JSON.stringify(after.entries)) return;
    } catch {
      if (this.disposed || this.listings.get(path) !== previous) return;
      this.listings.delete(path);
    }
    for (const key of this.listings.keys()) if (relativeFile(path, key)) this.listings.delete(key);
    for (const [key, watcher] of this.watchers) {
      if (relativeFile(path, key)) { watcher.dispose(); this.watchers.delete(key); }
    }
    this.changed(owner);
  }

  /** Stat only symbolic links; regular children need no per-file filesystem requests. */
  private async readDirectory(path: string): Promise<DirectorySnapshot> {
    const [real, entries] = await Promise.all([realpath(path), readdir(path, { withFileTypes: true })]);
    const children = await Promise.all(entries.map(async entry => {
      const link = entry.isSymbolicLink();
      let directory = entry.isDirectory();
      if (link) {
        try { directory = (await stat(join(path, entry.name))).isDirectory(); }
        catch { /* A dangling link remains visible so its missing target is not silently hidden. */ }
      }
      return { name: entry.name, directory, link };
    }));
    children.sort((a, b) => Number(b.directory) - Number(a.directory)
      || a.name.localeCompare(b.name, "en", { numeric: true }) || a.name.localeCompare(b.name));
    return { real, entries: children };
  }

  /** Reuse one shallow root snapshot for settings, documentation and other files. */
  private async scopeFiles(scope: FileScope): Promise<DirectoryEntry[]> {
    const snapshot = await this.listing(scope.path, scope.project?.info.scope.kind === "member" ? scope.project : undefined);
    return snapshot.entries.filter(entry => !this.excluded(join(scope.path, entry.name), scope));
  }

  /** Keep standalone files at view level and member files below their configuration; hide absent categories. */
  async groups(project?: ProjectTree): Promise<FileGroup[]> {
    if (project?.info.scope.kind === "standalone") return [];
    const scope = this.scopes.find(scope => scope.project === project)
      ?? (!project ? this.scopes.find(scope => scope.project?.info.scope.kind === "standalone") : undefined);
    if (!scope) return [];
    const files = await this.scopeFiles(scope);
    const categories = new Set(files.map(entry => fileCategory(entry.name, entry.directory)));
    return scope.groups.filter(group => categories.has(group.kind));
  }

  /** Materialize physical children lazily, leaving source and member exclusions active at every depth. */
  async children(parent: FileGroup | FileEntry): Promise<FileEntry[]> {
    let group = parent;
    while (group.fileKind === "entry") group = group.parent;
    const scope = group.scope;
    const path = parent.fileKind === "entry" ? parent.path : scope.path;
    if (parent.fileKind === "entry" && !parent.directory) return [];
    const snapshot = await this.listing(path, parent.fileKind === "group" ? scope.project?.info.scope.kind === "member" ? scope.project : undefined : parent);
    // A link may point back to any physical ancestor. Stop that branch without hiding the link itself.
    if (parent.fileKind === "entry") {
      let ancestor = parent.parent;
      while (ancestor.fileKind === "entry") {
        if ((await this.listing(ancestor.path, ancestor)).real === snapshot.real) return [];
        ancestor = ancestor.parent;
      }
      if ((await this.listing(scope.path, scope.project?.info.scope.kind === "member" ? scope.project : undefined)).real === snapshot.real) return [];
    }
    return snapshot.entries.filter(entry => {
      if (this.excluded(join(path, entry.name), scope)) return false;
      return parent.fileKind === "entry" || fileCategory(entry.name, entry.directory) === parent.kind;
    }).map(entry => ({ fileKind: "entry", key: `file:${join(path, entry.name)}`, path: join(path, entry.name),
      directory: entry.directory, link: entry.link, parent }));
  }

  /** Follow only the active file's ancestors, never recursively search the workspace. */
  async reveal(path: string): Promise<FileEntry | undefined> {
    const scopes = [...this.scopes].sort((a, b) => b.path.length - a.path.length);
    for (const scope of scopes) {
      if (!relativeFile(scope.path, path)) continue;
      for (const group of await this.groups(scope.project?.info.scope.kind === "member" ? scope.project : undefined)) {
        let children = await this.children(group);
        for (let depth = 0; depth < 128; depth++) {
          const entry = children.find(entry => entry.path === path || (entry.directory && relativeFile(entry.path, path)));
          if (!entry) break;
          if (entry.path === path) return entry;
          children = await this.children(entry);
        }
      }
    }
    return undefined;
  }

  /** Refresh recovers stale or watcher-excluded folders without touching the metadata cache. */
  refresh(): void { this.listings.clear(); }

  /** Release directory subscriptions and pending snapshots when a connection is replaced. */
  dispose(): void {
    this.disposed = true;
    for (const watcher of this.watchers.values()) watcher.dispose();
    this.watchers.clear();
    this.listings.clear();
  }
}

/** Keep file names literal; only synthetic groups have translated labels. */
export function fileName(entry: FileEntry): string { return basename(entry.path); }
