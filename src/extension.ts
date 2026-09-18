import * as vscode from "vscode";
import { SearchView } from "./search-view.js";
import { Connection, type ConnectionState } from "./connection.js";
import { assertHost } from "./host.js";
import { message, type MessageKey } from "./messages.js";
import { ExplorerError } from "./protocol.js";
import { MetadataTree, type TreeEntry, type ProjectTree } from "./tree.js";
import { isCommonModule, resolveSource } from "./source.js";
import { ProjectWatcher, watchManifests } from "./watch.js";

interface Notice { label: string; project?: ProjectTree; parent?: TreeEntry }
type Element = TreeEntry | Notice;

let active: Explorer | undefined;

/** Activation registers only Explorer UI; no backend runs before a view or command needs it. */
export function activate(context: vscode.ExtensionContext): unknown {
  active = new Explorer(context);
  context.subscriptions.push(active);
  return context.extensionMode === vscode.ExtensionMode.Test ? active : undefined;
}

/** VS Code awaits this promise before unloading the extension host. */
export async function deactivate(): Promise<void> {
  await active?.shutdown();
  active = undefined;
}

/** A connection view intentionally has no XML parsing or metadata schema. */
class Explorer implements vscode.TreeDataProvider<Element>, vscode.Disposable {
  private readonly changed = new vscode.EventEmitter<Element | Element[] | undefined>();
  readonly onDidChangeTreeData = this.changed.event;
  private readonly output = vscode.window.createOutputChannel("eska Explorer", { log: true });
  private readonly connection: Connection;
  private readonly view: vscode.TreeView<Element>;
  private readonly disposables: vscode.Disposable[] = [];
  private tree: MetadataTree | undefined;
  private searchView: SearchView | undefined;
  private watchers: vscode.Disposable[] = [];
  private readonly expanded = new Map<string, boolean>();
  private readonly recovering = new Set<ProjectTree>();
  private treeLanguage = this.resolveTreeLanguage();
  private opening = 0;
  private selected: vscode.WorkspaceFolder | undefined;
  private attempted = false;
  private selecting = false;
  private disposed = false;
  private stopping: Promise<void> | undefined;

  constructor(private readonly context: vscode.ExtensionContext) {
    this.connection = new Connection(String(context.extension.packageJSON.version),
      (state) => this.update(state), (text, level) => this.output[level ?? "info"](text));
    this.view = vscode.window.createTreeView("eska.explorer.projects", { treeDataProvider: this });
    for (const [name, action] of [
      ["connect", () => this.connect(true)],
      ["restart", () => this.connect(false)],
      ["disconnect", () => this.connection.disconnect()],
      ["showLog", () => this.output.show(true)],
      ["refresh", () => this.refresh()],
      ["search", () => this.search()],
    ] as const) {
      this.disposables.push(vscode.commands.registerCommand(`eska.explorer.${name}`, action));
    }
    // Context actions accept the native tree element; palette refresh has no argument.
    this.disposables.push(vscode.commands.registerCommand("eska.explorer.refreshNode", (entry: Element) => this.refresh(entry)));
    this.disposables.push(vscode.commands.registerCommand("eska.explorer.openSource", (entry: TreeEntry) => this.open(entry)));
    this.disposables.push(vscode.commands.registerCommand("eska.explorer.openXml", (entry: TreeEntry) => this.open(entry, "xml")));
    this.disposables.push(this.view.onDidExpandElement(({ element }) => {
      if ("node" in element) this.expanded.set(element.key, true);
    }));
    this.disposables.push(this.view.onDidCollapseElement(({ element }) => {
      if ("node" in element) this.expanded.set(element.key, false);
    }));
    this.disposables.push(this.view.onDidChangeVisibility(({ visible }) => {
      if (visible && !this.attempted) void this.connect(false);
    }));
    this.disposables.push(vscode.workspace.onDidChangeWorkspaceFolders(() => {
      if (this.selected && !this.folders().some((folder) => folder.uri.toString() === this.selected?.uri.toString())) {
        this.selected = undefined;
        void this.connection.disconnect();
      }
    }));
    this.disposables.push(vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration("eska.explorer.executable", this.selected?.uri)) {
        void this.connection.disconnect();
      }
      if (event.affectsConfiguration("eska.explorer.treeLanguage")) {
        this.treeLanguage = this.resolveTreeLanguage();
        this.searchView?.refreshLabels();
        // Labels already contain both translations; reuse nodes and their expansion state.
        this.changed.fire(undefined);
      }
    }));
    if (this.view.visible) void this.connect(false);
  }

  /** Resolve the active host locale without changing the workspace's language providers. */
  private text(key: MessageKey, ...values: string[]): string { return message(vscode.env.language, key, ...values); }

  /** Only metadata labels use this override; commands and errors retain the editor's language. */
  private resolveTreeLanguage(): "ru-RU" | "en-US" {
    const language = vscode.workspace.getConfiguration("eska.explorer").get<string>("treeLanguage", "auto");
    return language === "ru-RU" || language === "en-US" ? language
      : vscode.env.language.toLowerCase().startsWith("ru") ? "ru-RU" : "en-US";
  }

  /** Query only roots or the expanded branch; errors stay next to their owning project/object. */
  async getChildren(entry?: Element): Promise<Element[]> {
    const tree = this.tree;
    if (tree) {
      try {
        if (entry && (!("node" in entry) || isCommonModule(entry))) return [];
        const children: Element[] = [];
        if (entry) children.push(...await tree.children(entry));
        else for (const project of tree.projects) {
          try { children.push(await tree.root(project)); }
          catch (error) { children.push({ label: this.text(error instanceof ExplorerError ? error.code : "branchInvalid"), project }); }
        }
        return tree === this.tree ? children : [];
      } catch (error) {
        if (tree !== this.tree) return [];
        const failure = error instanceof ExplorerError ? error : new ExplorerError("branchInvalid");
        this.output.info(`tree_error code=${failure.code} kind=${failure.domain ?? "none"}`);
        return [{ label: this.text(failure.code), ...(entry && "node" in entry ? { parent: entry, project: entry.project } : {}) }];
      }
    }
    const state = this.connection.state;
    return [{ label: this.text(state.kind === "error" ? state.error.code : state.kind === "ready" ? "connecting" : state.kind) }];
  }

  /** Native TreeItems inherit zoom, keyboard navigation, themes and accessible text from VS Code. */
  getTreeItem(entry: Element): vscode.TreeItem {
    if (!("node" in entry)) {
      const item = new vscode.TreeItem(entry.label);
      item.id = `${entry.parent?.key ?? entry.project?.key ?? "connection"}:notice`;
      item.iconPath = new vscode.ThemeIcon("warning");
      item.command = { command: this.tree ? "eska.explorer.refreshNode" : "eska.explorer.connect",
        title: this.text(this.tree ? "refresh" : "select"), arguments: [entry] };
      return item;
    }
    const node = entry.node;
    const label = node.label.kind === "name" ? node.label.text
      : node.label.translations[this.treeLanguage];
    const commonModule = isCommonModule(entry);
    const expanded = this.expanded.get(entry.key) ?? node.expandedByDefault;
    const item = new vscode.TreeItem(label, commonModule || node.state === "empty" ? vscode.TreeItemCollapsibleState.None
      : expanded ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.Collapsed);
    item.id = entry.key;
    item.contextValue = commonModule ? "eskaCommonModule" : "eskaMetadata";
    item.accessibilityInformation = { label };
    // The special folder icon makes VS Code omit leaf twistie space in file-only icon themes.
    // A regular product icon keeps group and child indentation consistent without changing user settings.
    item.iconPath = new vscode.ThemeIcon(node.state === "error" ? "warning"
      : commonModule || node.id.kind === "module" ? "file-code" : node.id.kind === "collection" ? "symbol-namespace" : "symbol-class");
    if (!node.parent) item.description = entry.project.info.scope.kind === "member"
      ? `${entry.project.info.scope.name} · ${this.text(entry.project.info.type)}` : this.text(entry.project.info.type);
    if (node.id.kind !== "collection") item.command = { command: "eska.explorer.openSource", title: this.text("openSource"), arguments: [entry] };
    return item;
  }

  /** Native reveal uses backend-provided ancestry already present in the lazy tree. */
  getParent(entry: Element): Element | undefined {
    return "node" in entry ? this.tree?.parent(entry) : entry.parent;
  }

  /** Search reuses the current backend context and reveals only the chosen branch. */
  private async search(): Promise<void> {
    if (!this.tree) await this.connect(false);
    const tree = this.tree;
    if (!tree || this.disposed) return;
    if (this.searchView) { this.searchView.show(); return; }
    this.searchView = new SearchView(tree, () => this.treeLanguage, async (entry) => {
      try {
        if (this.tree !== tree) throw new ExplorerError("obsolete");
        await vscode.commands.executeCommand("eska.explorer.projects.focus");
        if (this.tree !== tree) throw new ExplorerError("obsolete");
        await this.view.reveal(entry, { select: true, focus: true });
      } catch (error) { this.showError(error instanceof ExplorerError ? error : new ExplorerError("sourceMissing")); }
    }, () => { this.searchView = undefined; });
  }

  /** A manual refresh can recover a single descriptor or all current projects. */
  private async refresh(entry?: Element): Promise<void> {
    const tree = this.tree;
    if (!tree) return;
    const node = entry && "node" in entry ? entry : entry?.parent;
    const projects = entry?.project ? [entry.project] : tree.projects;
    for (const project of projects) {
      this.recovering.add(project);
      try { await tree.refresh(project, project.info.requiresRefresh ? undefined : node); }
      catch (error) {
        if (tree === this.tree) this.showError(error instanceof ExplorerError ? error : new ExplorerError("branchInvalid"));
      } finally { this.recovering.delete(project); }
    }
  }

  /** Automatic recovery is bounded to one attempt; a failed XML stays visible until corrected. */
  private recover(project: ProjectTree, reopen: boolean): void {
    const tree = this.tree;
    if (!tree || this.recovering.has(project)) return;
    if (reopen) { void this.connect(false); return; }
    this.recovering.add(project);
    void tree.refresh(project).catch((error: unknown) => {
      this.output.info(`refresh_error code=${error instanceof ExplorerError ? error.code : "requestFailed"}`);
    }).finally(() => this.recovering.delete(project));
  }

  /** Open only resolved existing sources, preserving unsaved buffers and rejecting stale positions. */
  private async open(entry: TreeEntry, target: "default" | "xml" = "default"): Promise<void> {
    const tree = this.tree;
    if (!tree || !entry || !("node" in entry) || !tree.projects.includes(entry.project)) return;
    const opening = ++this.opening;
    try {
      const source = await resolveSource(tree, entry, target);
      if (opening !== this.opening || tree !== this.tree) return;
      const document = await vscode.workspace.openTextDocument(vscode.Uri.file(source.path));
      if (opening !== this.opening || tree !== this.tree) return;
      if (source.position && (document.isDirty || document.getText() !== source.position.text)) throw new ExplorerError("sourceChanged");
      const editor = await vscode.window.showTextDocument(document, { preview: true, preserveFocus: false });
      if (source.position) {
        editor.selection = new vscode.Selection(document.positionAt(source.position.start), document.positionAt(source.position.end));
        editor.revealRange(editor.selection, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
      }
    } catch (error) {
      if (opening === this.opening && tree === this.tree) {
        this.showError(error instanceof ExplorerError ? error : new ExplorerError("sourceMissing"));
      }
    }
  }

  /** Selection is explicit for unrelated multi-root folders; workspace members are opened by eska. */
  private async connect(choose: boolean): Promise<void> {
    if (this.disposed || this.selecting) return;
    this.attempted = true;
    this.selecting = true;
    try {
      if (!vscode.workspace.isTrusted) throw new ExplorerError("untrusted");
      const folders = this.folders();
      if (!folders.length) throw new ExplorerError("noFolder");
      let folder = choose ? undefined : this.selected;
      if (!folder) {
        folder = folders.length === 1 ? folders[0] : (await vscode.window.showQuickPick(
          folders.map((value) => ({ label: value.name, description: value.uri.fsPath, folder: value })),
          { placeHolder: this.text("choose"), ignoreFocusOut: true },
        ))?.folder;
      }
      if (!folder || this.disposed) return;
      if (!this.folders().some((value) => value.uri.toString() === folder.uri.toString())) return;
      assertHost(vscode.workspace.isTrusted, folder.uri.scheme, vscode.env.remoteName);
      this.selected = folder;
      const executable = vscode.workspace.getConfiguration("eska.explorer", folder.uri).get<string>("executable", "eska");
      // Release the picker guard before the asynchronous handshake, allowing disconnect/restart.
      this.selecting = false;
      await this.connection.connect({ executable, path: folder.uri.fsPath, name: folder.name,
        locale: vscode.env.language.toLowerCase().startsWith("ru") ? "ru-RU" : "en-US" });
    } catch (error) {
      this.showError(error instanceof ExplorerError ? error : new ExplorerError("spawnFailed"));
    } finally { this.selecting = false; }
  }

  /** Read workspace folders afresh after pickers or asynchronous lifecycle operations. */
  private folders(): readonly vscode.WorkspaceFolder[] { return vscode.workspace.workspaceFolders ?? []; }

  /** Process logs never become the view's labels or user-facing error text. */
  private update(state: ConnectionState): void {
    if (this.disposed) return;
    this.searchView?.dispose();
    this.tree?.dispose();
    this.tree = undefined;
    for (const watcher of this.watchers) watcher.dispose();
    this.watchers = [];
    this.opening++;
    if (state.kind === "ready") {
      const tree = new MetadataTree(this.connection, state.session,
        (entries) => this.changed.fire(entries), (project, reopen) => this.recover(project, reopen));
      this.tree = tree;
      try {
        for (const project of tree.projects) this.watchers.push(new ProjectWatcher(tree, project,
          (error) => { this.output.info(`watch_error code=${error instanceof ExplorerError ? error.code : "requestFailed"}`); }));
        this.watchers.push(watchManifests(state.target.path, tree.projects, () => { void this.connect(false); }));
      } catch (error) { this.showError(error instanceof ExplorerError ? error : new ExplorerError("unsupportedPath")); }
    }
    this.changed.fire(undefined);
    this.view.message = state.kind === "ready" ? this.text("ready", state.version) : "";
    if (state.kind === "error") this.showError(state.error);
  }

  /** Setup instructions are a packaged document, not an automatic init or executable installer. */
  private showError(error: ExplorerError): void {
    const setup = error.code === "manifestMissing" || error.code === "executableMissing" || error.code === "incompatible" || error.code === "handshakeFailed";
    void vscode.window.showErrorMessage(this.text(error.code), this.text(setup ? "initialization" : "log"))
      .then((choice) => {
        if (!choice || this.disposed) return;
        if (setup) {
          const name = vscode.env.language.toLowerCase().startsWith("ru") ? "setup.ru.md" : "setup.md";
          void vscode.commands.executeCommand("markdown.showPreview", vscode.Uri.joinPath(this.context.extensionUri, "docs", name));
        } else this.output.show(true);
      });
  }

  /** Keep the output alive while the final child exit is logged. */
  shutdown(): Promise<void> {
    if (!this.stopping) {
      this.disposed = true;
      for (const disposable of this.disposables) disposable.dispose();
      this.searchView?.dispose();
      this.tree?.dispose();
      for (const watcher of this.watchers) watcher.dispose();
      this.view.dispose();
      this.changed.dispose();
      this.stopping = this.connection.dispose().finally(() => this.output.dispose());
    }
    return this.stopping;
  }

  /** The synchronous subscription hook shares cleanup with the awaited deactivate hook. */
  dispose(): void { void this.shutdown(); }
}
