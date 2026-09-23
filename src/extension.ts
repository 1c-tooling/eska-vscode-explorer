import { SupportContexts } from "./support-contexts.js";
import { SupportController } from "./support.js";
import * as vscode from "vscode";
import { BackendSetup } from "./backend-setup.js";
import { GitDecorations } from "./decorations.js";
import { revealFile, relativeFile } from "./reveal.js";
import { iconName } from "./icons.js";
import { SearchView } from "./search-view.js";
import { Connection, type ConnectionState } from "./connection.js";
import { assertHost } from "./host.js";
import { message, type MessageKey } from "./messages.js";
import { ExplorerError } from "./protocol.js";
import { MetadataTree, type TreeEntry, type ProjectTree } from "./tree.js";
import { ProjectSorting, type SortOrder } from "./sorting.js";
import { ProjectFilters, isHiddenSection, supportsRootFilter } from "./filter.js";
import { nativePath, isCommonModule, directModuleRole, isModuleLeaf, isForm, resolveSource, type SourceTarget } from "./source.js";
import { FormSources, type FormSource } from "./forms.js";
import { WorkspaceFiles, fileName, type WorkspaceEntry } from "./workspace-files.js";
import { ProjectWatcher, watchManifests, watchDirectory } from "./watch.js";

interface Notice { label: string; loading?: boolean; supportFailure?: boolean; project?: ProjectTree; parent?: Element }
type Element = TreeEntry | Notice | FormSource | WorkspaceEntry;

let active: Explorer | undefined;

/** Activation starts workspace protection independently of whether the tree is expanded. */
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
  private readonly decorations = new GitDecorations();
  private readonly output = vscode.window.createOutputChannel("ESKA Explorer", { log: true });
  private readonly connection: Connection;
  private readonly setup: BackendSetup;
  private readonly view: vscode.TreeView<Element>;
  private readonly status = vscode.window.createStatusBarItem("eska.explorer.connection", vscode.StatusBarAlignment.Right, 0);
  private readonly disposables: vscode.Disposable[] = [];
  readonly support: SupportController;
  private readonly supportContexts: SupportContexts;
  private tree: MetadataTree | undefined;
  private files: WorkspaceFiles | undefined;
  private searchView: SearchView | undefined;
  private watchers: vscode.Disposable[] = [];
  private readonly iconPaths = new Map<string, vscode.Uri>();
  private readonly filters: ProjectFilters;
  private readonly sorting: ProjectSorting;
  private readonly expanded = new Map<string, boolean>();
  private readonly forms = new FormSources();
  private readonly recovering = new Set<ProjectTree>();
  private treeLanguage = this.resolveTreeLanguage();
  private opening = 0;
  private selected: vscode.WorkspaceFolder | undefined;
  private attempted = false;
  private selecting = false;
  private connecting: AbortController | undefined;
  private disposed = false;
  private stopping: Promise<void> | undefined;
  private supportSelection: { tree: MetadataTree; entry: TreeEntry } | undefined;

  constructor(private readonly context: vscode.ExtensionContext) {
    this.support = new SupportController(context, () => this.supportRepaint(), text => this.output.warn(text));
    this.supportContexts = new SupportContexts(String(context.extension.packageJSON.version), (trees, pending) => this.support.setAdditionalTrees(trees, pending), () => this.support.invalidate(), text => this.output.info(text));
    this.decorations.support = entry => this.support.object(entry)?.state === "unknown" ? this.support.decoration(entry) : undefined;
    this.status.name = "ESKA Explorer";
    this.status.command = "eska.explorer.checkUpdates";
    this.disposables.push(this.status, this.decorations);
    this.filters = new ProjectFilters(context.workspaceState);
    this.sorting = new ProjectSorting(context.workspaceState);
    this.connection = new Connection(String(context.extension.packageJSON.version),
      (state) => this.update(state), (text, level) => this.output[level ?? "info"](text));
    this.setup = new BackendSetup(context, (text, level) => { if (!this.disposed) this.output[level ?? "info"](text); },
      () => this.connection.disconnect(), () => this.connect(false));
    this.disposables.push(this.setup);
    this.view = vscode.window.createTreeView("eska.explorer.projects", { treeDataProvider: this });
    for (const [name, action] of [
      ["connect", () => this.connect(true)],
      ["restart", () => this.connect(false)],
      ["disconnect", () => this.disconnect()],
      ["showLog", () => this.output.show(true)],
      ["checkUpdates", () => this.setup.check(true)],
      ["refresh", () => this.refresh()],
      ["search", () => this.search()],
      ["revealActiveFile", () => this.revealActiveFile()],
    ] as const) {
      this.disposables.push(vscode.commands.registerCommand(`eska.explorer.${name}`, action));
    }
    // Context actions accept the native tree element; palette refresh has no argument.
    this.disposables.push(vscode.commands.registerCommand("eska.explorer.refreshNode", (entry: Element) => this.refresh(entry)));
    this.disposables.push(vscode.commands.registerCommand("eska.explorer.openSource", (entry: TreeEntry) => this.open(entry)));
    this.disposables.push(vscode.commands.registerCommand("eska.explorer.openXml", (entry: TreeEntry) => this.open(entry, "xml")));
    this.disposables.push(vscode.commands.registerCommand("eska.explorer.openFormSource", (entry: FormSource) =>
      this.open(entry.owner, entry.target)));
    for (const name of ["hideEmptyGroups", "showEmptyGroups", "resetRootFilter"] as const) {
      this.disposables.push(vscode.commands.registerCommand(`eska.explorer.${name}`, (entry: Element) =>
        this.setRootFilter(entry, name === "resetRootFilter" ? undefined : name === "hideEmptyGroups")));
    }
    this.disposables.push(vscode.commands.registerCommand("eska.explorer.sortObjects", (entry: Element) => this.toggleSortOrder(entry)));
    this.disposables.push(vscode.commands.registerCommand("eska.explorer.resetSortOrder", (entry: Element) => this.toggleSortOrder(entry)));
    this.disposables.push(vscode.window.onDidChangeActiveColorTheme(() => this.changed.fire(undefined)));
    this.disposables.push(this.view.onDidExpandElement(({ element }) => {
      if ("key" in element) this.expanded.set(element.key, true);
    }));
    this.disposables.push(this.view.onDidCollapseElement(({ element }) => {
      if ("key" in element) this.expanded.set(element.key, false);
    }));
    this.disposables.push(this.view.onDidChangeVisibility(({ visible }) => {
      if (visible && !this.attempted) void this.connect(false);
    }));
    this.disposables.push(vscode.workspace.onDidChangeWorkspaceFolders(() => {
      if (this.selected && !this.folders().some((folder) => folder.uri.toString() === this.selected?.uri.toString())) {
        this.selected = this.folders()[0];
        if (this.selected) void this.connect(false);
        else void this.disconnect();
      } else if (this.connection.state.kind === "ready") {
        const target = this.connection.state.target;
        void this.supportContexts.start(this.folders().filter(folder => folder.uri.fsPath !== target.path).map(folder => ({ ...target, path: folder.uri.fsPath, name: folder.name })));
      }
    }));
    this.disposables.push(vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration("eska.explorer.executable", this.selected?.uri)) {
        void this.disconnect();
      }
      if (event.affectsConfiguration("eska.explorer.hideEmptyRootGroups")) {
        void this.repaint(this.tree?.projects.flatMap((project) => project.root ? [project.root] : []));
      }
      if (event.affectsConfiguration("eska.explorer.treeLanguage")) {
        this.treeLanguage = this.resolveTreeLanguage();
        this.searchView?.refreshLabels();
        // Labels already contain both translations; reuse nodes and their expansion state.
        this.changed.fire(undefined);
      }
    }));
    this.disposables.push(vscode.window.onDidChangeActiveTextEditor(() => this.updateKeyboardContext()));
    this.selected = this.folders()[0];
    if (this.selected) void this.connect(false);
  }

  /** Resolve the active host locale without changing the workspace's language providers. */
  private text(key: MessageKey, ...values: string[]): string { return message(vscode.env.language, key, ...values); }

  /** Only metadata labels use this override; commands and errors retain the editor's language. */
  private resolveTreeLanguage(): "ru-RU" | "en-US" {
    const language = vscode.workspace.getConfiguration("eska.explorer").get<string>("treeLanguage", "auto");
    return language === "ru-RU" || language === "en-US" ? language
      : vscode.env.language.toLowerCase().startsWith("ru") ? "ru-RU" : "en-US";
  }

  /** Discard filesystem and metadata results after disconnect or a session replacement. */
  async getChildren(entry?: Element): Promise<Element[]> {
    const tree = this.tree;
    const children = await this.loadChildren(entry);
    return !this.disposed && tree === this.tree ? children : [];
  }

  /** Query only roots or the expanded branch; errors stay next to their owning project/object. */
  private async loadChildren(entry?: Element): Promise<Element[]> {
    const tree = this.tree;
    if (tree) {
      if (this.support.loading) return [{ label: this.text("supportLoading"), loading: true }];
      if (this.support.failed) return [{ label: this.text("supportFailed"), supportFailure: true }];
      try {
        if (entry && "fileKind" in entry) {
          const children = await this.files?.children(entry) ?? [];
          return tree === this.tree ? children : [];
        }
        if (entry && (!("node" in entry) || isModuleLeaf(entry))) return [];
        if (entry && isForm(entry)) {
          const rows = await this.forms.children(tree, entry);
          return tree === this.tree ? this.sorting.rows(entry.project, rows, this.treeLanguage,
            row => message(this.treeLanguage, row.target === "form" ? "formSource" : "formModule")) : [];
        }
        const children: Element[] = [];
        if (entry) {
          const all = await tree.children(entry);
          const hide = this.hideEmptyGroups(entry.project);
          children.push(...this.sorting.children(entry.project, all, this.treeLanguage).filter((child) => !isHiddenSection(child, hide)
            && !(directModuleRole(entry) && child.node.id.kind === "collection" && child.node.id.collection.kind === "modules")));
        }
        else for (const project of tree.projects) {
          try { children.push(await tree.root(project)); }
          catch (error) { children.push({ label: this.text(error instanceof ExplorerError ? error.code : "branchInvalid"), project }); }
        }
        if (!entry || !entry.node.parent) children.push(...await this.files?.groups(entry?.project) ?? []);
        return tree === this.tree ? children : [];
      } catch (error) {
        if (tree !== this.tree) return [];
        const failure = error instanceof ExplorerError ? error : new ExplorerError("branchInvalid");
        this.output.info(`tree_error code=${failure.code} kind=${failure.domain ?? "none"}`);
        const fileBranch = entry && "fileKind" in entry;
        if (fileBranch) this.output.warn(`file_tree_error ${error instanceof Error ? error.message : String(error)}`);
        return [{ label: this.text(fileBranch ? "filesUnavailable" : failure.code),
          ...(entry ? { parent: entry } : {}), ...(entry && "node" in entry ? { project: entry.project } : {}) }];
      }
    }
    const state = this.connection.state;
    return [{ label: this.text(state.kind === "error" ? state.error.code : state.kind === "ready" ? "connecting" : state.kind) }];
  }

  /** Native TreeItems inherit zoom, keyboard navigation, themes and accessible text from VS Code. */
  getTreeItem(entry: Element): vscode.TreeItem {
    if ("fileKind" in entry) {
      const label = entry.fileKind === "group" ? message(this.treeLanguage, entry.kind) : fileName(entry);
      const item = new vscode.TreeItem(label, entry.fileKind === "entry" && !entry.directory ? vscode.TreeItemCollapsibleState.None
        : this.expanded.get(entry.key)
          ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.Collapsed);
      item.id = entry.key;
      item.contextValue = "eskaFiles";
      if (entry.fileKind === "entry") {
        item.resourceUri = vscode.Uri.file(entry.path);
        item.tooltip = entry.path;
        item.iconPath = entry.directory ? vscode.ThemeIcon.Folder : vscode.ThemeIcon.File;
        if (!entry.directory) item.command = { command: "vscode.open", title: this.text("openSource"), arguments: [item.resourceUri] };
      } else {
        const icons = { settings: "settings-gear", documentation: "book", other: "folder" };
        item.iconPath = new vscode.ThemeIcon(icons[entry.kind]);
        item.tooltip = entry.scope.path;
      }
      return item;
    }
    if ("owner" in entry) {
      const item = new vscode.TreeItem(message(this.treeLanguage, entry.target === "form" ? "formSource" : "formModule"));
      item.id = `${entry.owner.key}:source:${entry.target}`;
      item.contextValue = "eskaFormSource";
      item.resourceUri = this.decorations.resource(entry);
      item.tooltip = message(this.treeLanguage, entry.target === "form" ? "formSource" : "formModule");
      item.iconPath = this.metadataIcon(entry.owner, entry.target === "form" ? "form" : "module");
      item.command = { command: "eska.explorer.openFormSource", title: this.text("openSource"), arguments: [entry] };
      return item;
    }
    if (!("node" in entry)) {
      const item = new vscode.TreeItem(entry.label);
      item.id = `${entry.parent && "key" in entry.parent ? entry.parent.key : "connection"}:${entry.project?.key ?? ""}:notice`;
      item.iconPath = new vscode.ThemeIcon(entry.loading ? "loading~spin" : "warning");
      if (entry.loading) return item;
      if (entry.supportFailure) {
        item.command = { command: "eska.explorer.refresh", title: this.text("refresh") };
        return item;
      }
      item.command = { command: this.tree ? "eska.explorer.refreshNode" : "eska.explorer.connect",
        title: this.text(this.tree ? "refresh" : "select"), arguments: [entry] };
      return item;
    }
    const node = entry.node;
    const label = node.label.kind === "name" ? node.label.text
      : node.label.translations[this.treeLanguage];
    const commonModule = isCommonModule(entry);
    const expanded = this.expanded.get(entry.key) ?? node.expandedByDefault;
    const item = new vscode.TreeItem(label, isModuleLeaf(entry) || (node.parent && node.state === "empty" && !isForm(entry)) ? vscode.TreeItemCollapsibleState.None
      : expanded ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.Collapsed);
    item.id = entry.key;
    item.resourceUri = this.decorations.resource(entry);
    const support = this.support.object(entry);
    item.tooltip = support ? `${label}\n${this.support.explanation(entry)}` : label;
    item.contextValue = !node.parent
      ? supportsRootFilter(entry.project)
        ? this.hideEmptyGroups(entry.project) ? "eskaRootFiltered" : "eskaRootUnfiltered"
        : "eskaRoot"
      : commonModule ? "eskaCommonModule" : directModuleRole(entry) ? "eskaModuleObject" : isForm(entry) ? "eskaForm" : "eskaMetadata";
    if (!node.parent && this.sorting.order(entry.project) === "alphabetical") item.contextValue += "Sorted";
    item.accessibilityInformation = { label: support ? `${label}. ${this.support.explanation(entry)}` : label };
    item.iconPath = node.state === "error" ? new vscode.ThemeIcon("warning") : this.metadataIcon(entry);
    if (!node.parent) item.description = entry.project.info.scope.kind === "member"
      ? `${entry.project.info.scope.name} · ${this.text(entry.project.info.type)}` : this.text(entry.project.info.type);
    if (node.id.kind !== "collection") item.command = { command: "eska.explorer.openSource", title: this.text("openSource"), arguments: [entry] };
    return item;
  }

  /** Resolve bundled SVGs once per theme/type without file IO or backend requests while painting. */
  private metadataIcon(entry: TreeEntry, sourceIcon?: "form" | "module"): vscode.Uri {
    const kind = vscode.window.activeColorTheme.kind;
    const theme = kind === vscode.ColorThemeKind.HighContrast ? "contrast"
      : kind === vscode.ColorThemeKind.HighContrastLight ? "contrast-light"
      : kind === vscode.ColorThemeKind.Light ? "light" : "dark";
    const name = sourceIcon ?? iconName(entry.node, entry.project.info.type, this.tree?.parent(entry)?.node);
    const support = this.support.icon(entry);
    const key = support ? `support/generated/${theme}/${name}-${support}.svg` : `${theme}/${name}.svg`;
    let uri = this.iconPaths.get(key);
    if (!uri) {
      uri = vscode.Uri.joinPath(this.context.extensionUri, "resources", "icons", key);
      this.iconPaths.set(key, uri);
    }
    return uri;
  }

  /** Native reveal uses backend-provided ancestry already present in the lazy tree. */
  getParent(entry: Element): Element | undefined {
    if ("fileKind" in entry) {
      if (entry.fileKind === "entry") return entry.parent;
      return entry.scope.project?.info.scope.kind === "member" ? entry.scope.project.root : undefined;
    }
    if ("owner" in entry) return entry.owner;
    if (!("node" in entry)) return entry.parent;
    return this.tree?.parent(entry);
  }

  /** Limit shortcut overrides to files in the connected projects, including multi-root workspaces. */
  private updateKeyboardContext(): void {
    const uri = vscode.window.activeTextEditor?.document.uri;
    const activeProject = uri?.scheme === "file" && !!this.files?.scopes.some(scope =>
      relativeFile(scope.path, uri.fsPath) !== undefined);
    void vscode.commands.executeCommand("setContext", "eska.explorer.activeProject", activeProject);
    void vscode.commands.executeCommand("setContext", "eska.explorer.connected", !!this.tree);
  }

  /** Reveal the active source without replacing the document or changing unsaved text. */
  private async revealActiveFile(): Promise<void> {
    const uri = vscode.window.activeTextEditor?.document.uri;
    if (!uri || uri.scheme !== "file") return;
    if (!this.tree) await this.connect(false);
    const tree = this.tree;
    if (!tree) return;
    try {
      const entry = await revealFile(tree, uri.fsPath) ?? await this.files?.reveal(uri.fsPath);
      if (this.tree !== tree || this.disposed) return;
      if (!entry) { void vscode.window.showInformationMessage(this.text("fileNotInTree")); return; }
      await vscode.commands.executeCommand("eska.explorer.projects.focus");
      if (this.tree === tree && !this.disposed) await this.view.reveal(entry, { select: true, focus: true });
    } catch (error) {
      if (this.tree === tree && !this.disposed) this.showError(error instanceof ExplorerError ? error : new ExplorerError("sourceMissing"));
    }
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

  /** Resolve standard VS Code settings at the project folder, then apply its saved explicit choice. */
  private hideEmptyGroups(project: ProjectTree): boolean {
    const uri = vscode.Uri.file(nativePath(project.info.rootPath));
    const fallback = vscode.workspace.getConfiguration("eska.explorer", uri).get<boolean>("hideEmptyRootGroups", true);
    return this.filters.enabled(project, fallback);
  }

  /** A descendant of a hidden section also needs its selection moved to the project root. */
  private hiddenAncestor(entry: TreeEntry, tree: MetadataTree, hide: boolean): boolean {
    for (let current: TreeEntry | undefined = entry; current; current = tree.parent(current)) {
      if (isHiddenSection(current, hide)) return true;
    }
    return false;
  }

  /** Preserve native selection while the support preloader temporarily replaces the roots. */
  private supportRepaint(): void {
    const selected = this.view?.selection[0];
    if (this.support.loading && !this.supportSelection && this.tree && selected && "node" in selected) {
      this.supportSelection = { tree: this.tree, entry: selected };
    }
    this.decorations.invalidate();
    this.changed.fire(undefined);
    if (this.support.loading || this.support.failed) return;
    const saved = this.supportSelection;
    this.supportSelection = undefined;
    if (saved && saved.tree === this.tree && (!selected || !("node" in selected))) {
      void this.restoreSupportSelection(saved.tree, saved.entry);
    }
  }

  /** Resolve the surviving selection without focusing an editor or a stale session. */
  private async restoreSupportSelection(tree: MetadataTree, entry: TreeEntry): Promise<void> {
    try {
      const root = await tree.root(entry.project);
      await tree.children(root);
      const target = this.hiddenAncestor(entry, tree, this.hideEmptyGroups(entry.project)) ? root : entry;
      if (this.tree === tree && !this.support.loading && !this.disposed) {
        await this.view.reveal(target, { select: true, focus: false });
      }
    } catch { /* Deleted selections and broken branches have no surviving native target. */ }
  }

  /** Move a disappearing selection before VS Code discards it during the native tree refresh. */
  private async repaint(entries?: TreeEntry[]): Promise<void> {
    if (this.support.loading) return;
    const tree = this.tree;
    const selected = this.view.selection[0];
    if (tree && selected && "node" in selected && supportsRootFilter(selected.project)
      && this.hideEmptyGroups(selected.project)) {
      try {
        const root = await tree.root(selected.project);
        await tree.children(root);
        // Common child summaries can be invalidated while Common itself remains non-empty.
        // Refresh only the selected ancestry before deciding whether selection will disappear.
        for (let ancestor = tree.parent(selected); ancestor; ancestor = tree.parent(ancestor)) {
          if (ancestor.node.id.kind === "collection" && ancestor.node.id.collection.kind === "common") {
            if (ancestor.node.state !== "empty") await tree.children(ancestor);
            break;
          }
        }
        if (this.hiddenAncestor(selected, tree, true)) await this.selectRoot(selected.project, tree, selected);
      } catch { /* A broken branch still needs its normal error row rendered. */ }
    }
    if (this.tree === tree) this.changed.fire(entries);
  }

  /** Do not steal focus from an editor when an empty selected section disappears. */
  private async selectRoot(project: ProjectTree, tree: MetadataTree, selected: TreeEntry): Promise<void> {
    try {
      const root = await tree.root(project);
      if (this.tree === tree && this.view.selection[0] === selected) await this.view.reveal(root, { select: true, focus: false });
    } catch (error) {
      this.output.info(`filter_selection_error code=${error instanceof ExplorerError ? error.code : "requestFailed"}`);
    }
  }

  /** Change only view state; retain cached branches, expansion state and the backend search index. */
  private async setRootFilter(entry: Element, value: boolean | undefined): Promise<void> {
    const tree = this.tree;
    if (!tree || !entry || !("node" in entry) || entry.node.parent
      || !tree.projects.includes(entry.project) || !supportsRootFilter(entry.project)) return;
    try {
      await this.filters.set(entry.project, value);
      if (this.tree === tree) await this.repaint([entry]);
    } catch {
      void vscode.window.showErrorMessage(this.text("filterSaveFailed"));
    }
  }

  /** Reorder one project's visible branches without changing backend data or triggering eager loads. */
  private async toggleSortOrder(entry: Element): Promise<void> {
    const tree = this.tree;
    if (!tree || !entry || !("node" in entry) || entry.node.parent || !tree.projects.includes(entry.project)) return;
    await this.applySortOrder(entry, this.sorting.order(entry.project) === "alphabetical" ? "original" : "alphabetical");
  }

  /** Persist before repainting; a failed save leaves the existing order intact. */
  private async applySortOrder(entry: TreeEntry, order: SortOrder): Promise<void> {
    const tree = this.tree;
    try {
      await this.sorting.set(entry.project, order);
      if (this.tree !== tree || this.disposed) return;
      const selected = this.view.selection[0];
      this.changed.fire(entry);
      if (selected && "node" in selected && selected.project === entry.project) {
        try { await this.view.reveal(selected, { select: true, focus: false }); }
        catch (error) { this.output.info(`sort_selection_error code=${error instanceof ExplorerError ? error.code : "requestFailed"}`); }
      }
    } catch {
      void vscode.window.showErrorMessage(this.text("sortSaveFailed"));
    }
  }

  /** A manual refresh can recover a single descriptor or all current projects. */
  private async refresh(entry?: Element): Promise<void> {
    const tree = this.tree;
    if (!tree) return;
    this.files?.refresh();
    this.changed.fire(undefined);
    if (entry && "fileKind" in entry) return;
    if (entry && "parent" in entry && entry.parent && "fileKind" in entry.parent) {
      await this.refresh(entry.parent);
      return;
    }
    const parent = entry && "parent" in entry ? entry.parent : undefined;
    const node = entry && "owner" in entry ? entry.owner : entry && "node" in entry ? entry
      : parent && "node" in parent ? parent : undefined;
    const project = node?.project ?? (entry && "project" in entry ? entry.project : undefined);
    const projects = project ? [project] : tree.projects;
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
  private async open(entry: TreeEntry, target: SourceTarget = "default"): Promise<void> {
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

  /** Invalidate preflight as well as the protocol connection so late probes cannot reconnect. */
  private disconnect(): Promise<void> {
    this.connecting?.abort();
    this.selecting = false;
    return this.connection.disconnect();
  }

  /** Selection is explicit for unrelated multi-root folders; workspace members are opened by eska. */
  private async connect(choose: boolean): Promise<void> {
    if (this.disposed || this.selecting) return;
    this.connecting?.abort();
    const controller = new AbortController();
    this.connecting = controller;
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
      if (!folder || this.disposed || controller.signal.aborted) return;
      if (!this.folders().some((value) => value.uri.toString() === folder.uri.toString())) return;
      assertHost(vscode.workspace.isTrusted, folder.uri.scheme, vscode.env.remoteName);
      this.selected = folder;
      const global = await this.setup.ensure(controller.signal);
      if (!global || this.disposed || controller.signal.aborted) return;
      if (!this.folders().some(value => value.uri.toString() === folder.uri.toString())) return;
      const configured = vscode.workspace.getConfiguration("eska.explorer", folder.uri).get<string>("executable", "eska");
      const executable = configured === "eska" ? global : configured;
      // Release the picker guard before the asynchronous handshake, allowing disconnect/restart.
      this.selecting = false;
      await this.connection.connect({ executable, path: folder.uri.fsPath, name: folder.name,
        locale: vscode.env.language.toLowerCase().startsWith("ru") ? "ru-RU" : "en-US" });
    } catch (error) {
      if (!controller.signal.aborted && !this.disposed) this.showError(error instanceof ExplorerError ? error : new ExplorerError("spawnFailed"));
    } finally { if (this.connecting === controller) this.selecting = false; }
  }

  /** Read workspace folders afresh after pickers or asynchronous lifecycle operations. */
  private folders(): readonly vscode.WorkspaceFolder[] { return vscode.workspace.workspaceFolders ?? []; }

  /** Process logs never become the view's labels or user-facing error text. */
  private update(state: ConnectionState): void {
    if (this.disposed) return;
    void this.supportContexts.stop();
    this.searchView?.dispose();
    this.tree?.dispose();
    this.files?.dispose();
    this.files = undefined;
    this.tree = undefined;
    for (const watcher of this.watchers) watcher.dispose();
    this.watchers = [];
    this.opening++;
    if (state.kind === "ready") {
      const tree = new MetadataTree(this.connection, state.session,
        (entries) => { this.support.invalidate(); this.decorations.invalidate(); void this.repaint(entries); }, (project, reopen) => this.recover(project, reopen));
      this.tree = tree;
      this.files = new WorkspaceFiles(tree.projects, state.target.path, watchDirectory, entry => {
        if (this.tree !== tree) return;
        this.changed.fire(entry && ("fileKind" in entry ? entry : entry.root));
      });
      try {
        for (const project of tree.projects) this.watchers.push(new ProjectWatcher(tree, project,
          (error) => { this.output.info(`watch_error code=${error instanceof ExplorerError ? error.code : "requestFailed"}`); }));
        this.watchers.push(watchManifests(state.target.path, tree.projects, () => { void this.connect(false); }));
      } catch (error) { this.showError(error instanceof ExplorerError ? error : new ExplorerError("unsupportedPath")); }
    }
    this.support.setTree(this.tree, state.kind === "ready" && state.supportPolicy, state.kind === "disconnected" || state.kind === "stopping");
    if (state.kind === "ready") {
      void this.supportContexts.start(this.folders().filter(folder => folder.uri.fsPath !== state.target.path)
        .map(folder => ({ ...state.target, path: folder.uri.fsPath, name: folder.name })));
    }
    this.decorations.setTree(this.tree);
    this.updateKeyboardContext();
    this.changed.fire(undefined);
    if (state.kind === "ready") {
      this.status.text = `ESKA v${state.version}`;
      this.status.tooltip = this.text("statusTooltip", state.version, state.target.executable);
      this.status.show();
      void this.setup.background();
    } else {
      // Never leave a successful connection indicator after disconnect or process failure.
      this.status.hide();
      this.status.text = "";
      this.status.tooltip = undefined;
    }
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
      this.connecting?.abort();
      void vscode.commands.executeCommand("setContext", "eska.explorer.activeProject", false);
      void vscode.commands.executeCommand("setContext", "eska.explorer.connected", false);
      for (const disposable of this.disposables) disposable.dispose();
      this.searchView?.dispose();
      this.tree?.dispose();
      this.files?.dispose();
      for (const watcher of this.watchers) watcher.dispose();
      this.view.dispose();
      this.changed.dispose();
      this.stopping = Promise.all([this.supportContexts.stop(), this.support.shutdown(), this.connection.dispose(), this.setup.shutdown()]).then(() => {}).finally(() => this.output.dispose());
    }
    return this.stopping;
  }

  /** The synchronous subscription hook shares cleanup with the awaited deactivate hook. */
  dispose(): void { void this.shutdown(); }
}
