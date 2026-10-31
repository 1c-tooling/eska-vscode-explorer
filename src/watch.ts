import * as vscode from "vscode";
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import { watchFile, unwatchFile, type Stats } from "node:fs";
import { MetadataTree, type ProjectTree } from "./tree.js";
import { nativePath } from "./source.js";

/** Share source filtering between metadata batches and language-only sources outside the selected tree. */
export function watchSourceFiles(source: string, observed: (path: string) => void): vscode.FileSystemWatcher {
  const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(vscode.Uri.file(source), "**/*"));
  /** Directory events matter too; cache/Git writes must never feed analysis invalidation loops. */
  const changed = (uri: vscode.Uri): void => {
    if (uri.scheme !== "file") return;
    const path = relative(source, uri.fsPath), components = path.split(sep);
    if (!path || isAbsolute(path) || components.includes("..") || components.includes(".git") || components.includes(".eska")) return;
    observed(uri.fsPath);
  };
  watcher.onDidCreate(changed); watcher.onDidChange(changed); watcher.onDidDelete(changed);
  return watcher;
}

/** Bound and serialize filesystem batches; overflow becomes a full refresh rather than lost changes. */
export class ProjectWatcher implements vscode.Disposable {
  private readonly watcher: vscode.FileSystemWatcher;
  private readonly paths = new Set<string>();
  private timer: NodeJS.Timeout | undefined;
  private sequence = 0n;
  private full = false;
  private disposed = false;
  private running: Promise<void> | undefined;
  private readonly source: string;

  constructor(private readonly tree: MetadataTree, readonly project: ProjectTree,
    private readonly failed: (error: unknown) => void, private readonly observed: (path: string) => void) {
    this.source = nativePath(project.info.sourcePath);
    this.watcher = watchSourceFiles(this.source, path => this.add(path));
  }

  /** Queue only source-relative paths already validated by the shared observer. */
  private add(file: string): void {
    const path = relative(this.source, file);
    this.observed(file);
    if (!this.full) this.paths.add(path);
    if (this.paths.size > 4096) { this.paths.clear(); this.full = true; }
    this.schedule();
  }

  /** Coalesce editor saves without delaying the extension host's input events. */
  private schedule(): void {
    if (this.disposed || this.timer || this.running) return;
    this.timer = setTimeout(() => { this.timer = undefined; void this.flush(); }, 100);
  }

  /** A metadata barrier drains notifications before sending the next file sequence. */
  async flush(): Promise<void> {
    if (this.running) { await this.running; if (!this.disposed && (this.full || this.paths.size)) await this.flush(); return; }
    if (this.disposed || (!this.full && !this.paths.size)) return;
    this.running = this.deliver().catch(this.failed).finally(() => {
      this.running = undefined;
      if (this.full || this.paths.size) this.schedule();
    });
    await this.running;
  }

  /** Manual and overflow recovery preserve the file sequence because unsent events have no sequence yet. */
  private async deliver(): Promise<void> {
    if (this.full || this.project.info.requiresRefresh) {
      this.full = false;
      this.paths.clear();
      await this.tree.refresh(this.project);
      return;
    }
    const paths = [...this.paths].map((value) => ({ value, encoding: "utf-8" }));
    this.paths.clear();
    try {
      const sequence = this.sequence + 1n;
      this.tree.connection.notify(this.tree.session.sessionId, "workspace/didChangeFiles", {
        projectId: this.project.info.projectId, sequence: String(sequence), paths,
      });
      this.sequence = sequence;
      await this.tree.connection.request(this.tree.session.sessionId, "project/info");
    } catch (error) {
      // A synchronous transport rejection writes no bytes and does not consume its sequence.
      // Recover discarded paths once; pipe failures already invalidate the connection itself.
      if (!this.disposed) await this.tree.refresh(this.project);
      this.failed(error);
    }
  }

  /** Disposal stops timers and all native watcher registrations; in-flight responses are session-guarded. */
  dispose(): void {
    this.disposed = true;
    clearTimeout(this.timer);
    this.paths.clear();
    this.watcher.dispose();
  }
}

/** Watch exact manifests along discovery ancestry without parsing TOML or traversing directories. */
export function watchManifests(start: string, projects: readonly ProjectTree[], changed: () => void, observed: () => void): vscode.Disposable {
  const folders = new Set(projects.map((project) => nativePath(project.info.rootPath)));
  let folder = start;
  while (!folders.has(folder)) {
    folders.add(folder);
    const parent = dirname(folder);
    if (parent === folder) break;
    folder = parent;
  }
  // Even when start is the project root, a parent workspace manifest can define its context.
  for (folder = dirname(start); ; folder = dirname(folder)) {
    folders.add(folder);
    if (dirname(folder) === folder) break;
  }
  let timer: NodeJS.Timeout | undefined;
  let disposed = false;
  const watchers = [...folders].map(folder => {
    const path = join(folder, "eska.toml");
    // Workspace-native watchers can miss an edit during startup or below an excluded parent.
    // Poll only these exact small manifest files, including initially absent ancestors.
    const update = (current: Stats, previous: Stats): void => {
      if (disposed || current.mtimeMs === previous.mtimeMs && current.ctimeMs === previous.ctimeMs
        && current.size === previous.size && current.ino === previous.ino && current.nlink === previous.nlink) return;
      observed(); clearTimeout(timer); timer = setTimeout(changed, 150);
    };
    watchFile(path, { persistent: false, interval: 1000 }, update);
    return { dispose: () => unwatchFile(path, update) };
  });
  return { dispose: () => { disposed = true; clearTimeout(timer); for (const watcher of watchers) watcher.dispose(); } };
}

/** Observe one expanded filesystem directory and coalesce changes without traversing descendants. */
export function watchDirectory(path: string, changed: () => void): vscode.Disposable {
  const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(vscode.Uri.file(path), "*"));
  let timer: NodeJS.Timeout | undefined;
  /** A burst invalidates one shallow directory snapshot. */
  const update = (uri: vscode.Uri): void => {
    if (uri.scheme !== "file") return;
    clearTimeout(timer);
    timer = setTimeout(changed, 100);
  };
  // Content edits do not change a directory listing. Directory mtime events can come
  // from backend cache writes and must not repaint unrelated metadata branches.
  watcher.onDidCreate(update); watcher.onDidDelete(update);
  return { dispose: () => { clearTimeout(timer); watcher.dispose(); } };
}
