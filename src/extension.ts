import { FormattingService } from "./formatting/service.js";
import { QueryDesigner } from "./query/designer.js";
import { SupportContexts } from "./support-contexts.js";
import { SupportController } from "./support.js";
import { PROTECTED_SOURCE_SCHEME, ProtectedSources } from "./protected-source.js";
import { ProtectedLanguageFeatures } from "./protected-language.js";
import * as vscode from "vscode";
import { BackendSetup } from "./backend-setup.js";
import { ToolingSetup } from "./tooling/setup.js";
import { ToolFailure } from "./tooling/contracts.js";
import { LanguageService } from "./language/service.js";
import { QueryLanguage } from "./query/language.js";
import { GitDecorations } from "./decorations.js";
import { revealFile, relativeFile } from "./reveal.js";
import { iconName } from "./icons.js";
import { SearchView } from "./search-view.js";
import { Connection, type ConnectionState } from "./connection.js";
import { assertHost } from "./host.js";
import { message, type MessageKey } from "./messages.js";
import { ExplorerError, type BackendKind } from "./protocol.js";
import type { PropertyChoice } from "./properties.js";
import { PropertyTabs } from "./properties-view.js";
import { MetadataTree, type TreeEntry, type ProjectTree } from "./tree.js";
import { ProjectSorting, type SortOrder } from "./sorting.js";
import { ProjectFilters, isHiddenSection, supportsRootFilter } from "./filter.js";
import { nativePath, isCommonModule, directModuleRole, isModuleLeaf, isForm, resolveSource, resolveTreeSource, resolvePropertySource, type SourceTarget } from "./source.js";
import { FormSources, type FormSource } from "./forms.js";
import { QueryTabs } from "./query/tabs.js";
import { SourceAccess } from "./source-access.js";
import { isXmlQueryOwner } from "./query/owner.js";
import { queryBranches, queryLabel, queryLeaf, type QueryEntry } from "./query/tree.js";
import { WorkspaceFiles, fileName, type WorkspaceEntry } from "./workspace-files.js";
import { ProjectWatcher, watchManifests, watchDirectory } from "./watch.js";
import { basename } from "node:path";

interface Notice { label: string; loading?: boolean; supportFailure?: boolean; project?: ProjectTree; parent?: Element }
type Element = TreeEntry | Notice | FormSource | WorkspaceEntry | QueryEntry;

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
  private readonly tooling: ToolingSetup;
  private readonly language: LanguageService;
  private readonly formatting: FormattingService;
  private readonly queryDesigner: QueryDesigner;
  private readonly legacyNotices = new Set<string>();
  private readonly view: vscode.TreeView<Element>;
  private readonly status = vscode.window.createStatusBarItem("eska.explorer.connection", vscode.StatusBarAlignment.Right, 0);
  private readonly disposables: vscode.Disposable[] = [];
  readonly support: SupportController;
  private readonly protectedSources = new ProtectedSources(source => this.readProtectedSource(source), error =>
    this.output.warn(JSON.stringify({ event: "protected_source_read_failed", code: error instanceof ExplorerError ? error.code : "requestFailed",
      domain: error instanceof ExplorerError ? error.domain : undefined })));
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
  private readonly propertiesTabs: PropertyTabs;
  private readonly queries: QueryTabs;
  private readonly recovering = new Set<ProjectTree>();
  private treeLanguage = this.resolveTreeLanguage();
  private opening = 0;
  private selected: vscode.WorkspaceFolder | undefined;
  private attempted = false;
  private selecting = false;
  private connecting: AbortController | undefined;
  private connectionAttempt: Promise<void> = Promise.resolve();
  private disposed = false;
  private stopping: Promise<void> | undefined;
  private supportSelection: { tree: MetadataTree; entry: TreeEntry } | undefined;
  private languagePolicyRoots: readonly string[] = [];
  private additionalPolicyTrees: MetadataTree[] = [];
  private supportContextsKey: string | undefined;
  private supportContextsPending: Promise<void> = Promise.resolve();

  constructor(private readonly context: vscode.ExtensionContext) {
    this.support = new SupportController(context, entries => this.supportRepaint(entries), text => this.output.warn(text));
    this.supportContexts = new SupportContexts(String(context.extension.packageJSON.version), (trees, pending) => {
      this.additionalPolicyTrees = trees; this.support.setAdditionalTrees(trees, pending);
    }, () => this.support.invalidate(), text => this.output.info(text));
    this.status.name = "ESKA Explorer";
    this.status.command = "eska.explorer.components";
    this.disposables.push(this.status, this.decorations, this.protectedSources);
    this.disposables.push(new ProtectedLanguageFeatures(error => this.output.warn(String(error))));
    this.filters = new ProjectFilters(context.workspaceState);
    this.sorting = new ProjectSorting(context.workspaceState);
    this.propertiesTabs = new PropertyTabs(context, () => this.treeLanguage, () => this.tree,
      (entry, choice) => this.open(entry, "xml", choice));
    this.disposables.push(this.propertiesTabs);
    this.connection = new Connection(String(context.extension.packageJSON.version),
      (state) => this.update(state), (text, level) => this.output[level ?? "info"](text));
    this.disposables.push(this.connection.onSourceChange(() => this.protectedSources.refresh()));
    this.tooling = new ToolingSetup(context, (text, level) => { if (!this.disposed) this.output[level ?? "info"](text); },
      () => this.renderProjectStatus(), async kind => {
        if (kind === "project") { await this.formatting.stop(); await this.disconnect(); }
        else if (kind === "formatter") await this.formatting.stop(); else await this.language.stop();
      }, async kind => {
        if (kind === "project") await this.connect(false); else if (kind === "formatter") await this.formatting.stop(); else await this.language.restart(false);
      });
    this.disposables.push(this.tooling);
    this.language = new LanguageService(context, this.connection, this.tooling, this.output, (text, level) => this.output[level ?? "info"](text),
      this.support, roots => this.registerLanguagePolicyRoots(roots));
    this.disposables.push(this.language);
    this.queries = new QueryTabs(context, this.connection, () => this.tree, () => this.language.selectedApplication,
      entry => { if (!this.disposed) this.changed.fire(entry); }, value => this.output.warn(value));
    this.formatting = new FormattingService(String(context.extension.packageJSON.version), this.queries, this.tooling, (text, level) => this.output[level ?? "info"](text));
    void this.tooling.ensureFormatter(undefined, false).catch(() => {});
    this.language.attachQueries(new QueryLanguage(this.queries, value => this.output.warn(value)));
    this.queryDesigner = new QueryDesigner(context, this.queries, value => this.output.warn(value));
    this.setup = new BackendSetup(context, (text, level) => { if (!this.disposed) this.output[level ?? "info"](text); },
      () => this.connection.disconnect(), () => this.connect(false));
    this.disposables.push(this.setup);
    this.view = vscode.window.createTreeView("eska.explorer.projects", { treeDataProvider: this });
    for (const [name, action] of [
      ["connect", () => this.connect(true)],
      ["restart", () => this.connect(false)],
      ["disconnect", () => this.disconnect()],
      ["showLog", () => this.output.show(true)],
      ["components", () => this.tooling.showComponents()],
      ["checkUpdates", () => this.backendKind() === "legacy" ? this.setup.check(true, "legacy") : this.tooling.check("project")],
      ["checkAnalyzerUpdates", () => this.tooling.check("analyzer")],
      ["checkFormatterUpdates", () => this.tooling.check("formatter")],
      ["prepareTools", () => this.tooling.prepare(vscode.workspace.getConfiguration("eska.explorer", this.selected?.uri).get<string>("executable", "eska-project"), new AbortController().signal).catch(error => this.tooling.report(error))],
      ["recoverProjectInstallation", () => this.tooling.recover("project")],
      ["recoverAnalyzerInstallation", () => this.tooling.recover("analyzer")],
      ["recoverFormatterInstallation", () => this.tooling.recover("formatter")],
      ["restartLanguage", () => this.language.restart()],
      ["selectAnalysisContext", () => this.language.selectContext()],
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
    this.disposables.push(vscode.commands.registerCommand("eska.explorer.properties", (entry: TreeEntry) => this.showProperties(entry)));
    this.disposables.push(vscode.commands.registerCommand("eska.explorer.openFormSource", (entry: FormSource) =>
      this.open(entry.owner, entry.target)));
    this.disposables.push(vscode.commands.registerCommand("eska.explorer.openQuery", async (entry: QueryEntry) => {
      if (!this.tree || entry?.queryKind !== "query") return;
      try { await this.queries.show(this.tree, entry.owner, entry.header.identity); }
      catch (error) { this.queries.explain(error); }
    }));
    this.disposables.push(vscode.commands.registerCommand("eska.explorer.editBslQuery", async () => {
      const editor = vscode.window.activeTextEditor;
      try { if (!this.tree) await this.connect(false); await this.queries.showBsl(editor); }
      catch (error) { this.queries.explain(error); }
    }));
    this.disposables.push(vscode.commands.registerCommand("eska.explorer.queryConstructor", async (uri?: vscode.Uri) => {
      try { await this.queryDesigner.show(uri); }
      catch (error) { this.queries.explain(error); }
    }));
    this.disposables.push(vscode.commands.registerCommand("eska.explorer.placeQueryComments", async () => {
      try { await this.queries.placeComments(); }
      catch (error) { this.queries.explain(error); }
    }));
    this.disposables.push(vscode.commands.registerCommand("eska.explorer.applyQuery", async (uri?: vscode.Uri) => {
      try { await this.queries.apply(uri); }
      catch (error) { this.queries.explain(error); }
    }));
    this.disposables.push(vscode.commands.registerCommand("eska.explorer.cancelQuery", async (uri?: vscode.Uri) => {
      try { await this.queries.cancel(uri); }
      catch (error) { this.queries.explain(error); }
    }));
    this.disposables.push(vscode.commands.registerCommand("eska.explorer.resumeQuery", async () => {
      try { await this.queries.resume(); }
      catch (error) { this.queries.explain(error); }
    }));
    this.disposables.push(vscode.commands.registerCommand("eska.explorer.compareQueryOwner", async () => {
      try { await this.queries.compare(); }
      catch (error) { this.queries.explain(error); }
    }));
    this.disposables.push(vscode.commands.registerCommand("eska.explorer.openFile", (entry: WorkspaceEntry) => this.openFile(entry)));
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
        void this.refreshSupportContexts();
      }
    }));
    this.disposables.push(vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration("eska.explorer.analyzerExecutable")) {
        void this.language.restart(false);
      }
      if (event.affectsConfiguration("eska.explorer.languageFeatures")) void this.language.restart(false);
      if (event.affectsConfiguration("eska.explorer.executable", this.selected?.uri)
        || event.affectsConfiguration("eska.explorer.backend", this.selected?.uri)) {
        void this.disconnect();
      }
      if (event.affectsConfiguration("eska.explorer.supportPolicy")) {
        this.support.invalidate();
        const state = this.connection.state;
        if (state.kind === "ready") {
          void this.refreshSupportContexts();
        } else void this.supportContexts.stop();
      }
      if (event.affectsConfiguration("eska.explorer.hideEmptyRootGroups")) {
        void this.repaint(this.tree?.projects.flatMap((project) => project.root ? [project.root] : []));
      }
      if (event.affectsConfiguration("eska.explorer.treeLanguage")) {
        this.treeLanguage = this.resolveTreeLanguage();
        this.searchView?.refreshLabels();
        this.propertiesTabs.relabel();
        // Labels already contain both translations; reuse nodes and their expansion state.
        this.changed.fire(undefined);
      }
    }));
    this.disposables.push(vscode.window.onDidChangeActiveTextEditor(() => this.updateKeyboardContext()));
    this.selected = this.folders()[0];
    this.renderProjectStatus();
    void this.tooling.ensureAnalyzer(undefined, false).catch(error => this.tooling.report(error));
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
      try {
        if (entry && "queryKind" in entry) return entry.queryKind === "branch" ? [queryLeaf(entry)] : [];
        if (entry && "fileKind" in entry) {
          const children = await this.files?.children(entry) ?? [];
          return tree === this.tree ? children : [];
        }
        if (entry && (!("node" in entry) || isModuleLeaf(entry))) return [];
        if (entry && isForm(entry)) {
          const rows = await this.forms.children(tree, entry);
          const queries = await this.queryRows(tree, entry);
          return tree === this.tree ? [...this.sorting.rows(entry.project, rows, this.treeLanguage,
            row => message(this.treeLanguage, row.target === "form" ? "formSource" : "formModule")), ...queries] : [];
        }
        const children: Element[] = [];
        if (entry) {
          const all = await tree.children(entry);
          const hide = this.hideEmptyGroups(entry.project);
          children.push(...this.sorting.children(entry.project, all, this.treeLanguage).filter((child) => !isHiddenSection(child, hide)
            && !(directModuleRole(entry) && child.node.id.kind === "collection" && child.node.id.collection.kind === "modules")));
          children.push(...await this.queryRows(tree, entry));
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

  /** Discover persisted query identities through the backend while leaving unsupported template payloads alone. */
  private async queryRows(tree: MetadataTree, entry: TreeEntry): Promise<QueryEntry[]> {
    if (!isXmlQueryOwner(entry) || this.connection.state.kind !== "ready" || !this.connection.state.queryEditing) return [];
    try { return queryBranches(entry, await this.queries.discover(tree, entry)); }
    catch (error) {
      if (error instanceof ExplorerError && error.domain === "query_failed" && error.details?.reason === "unsupported_structure") return [];
      throw error;
    }
  }

  /** Native TreeItems inherit zoom, keyboard navigation, themes and accessible text from VS Code. */
  getTreeItem(entry: Element): vscode.TreeItem {
    if ("queryKind" in entry) {
      const item = new vscode.TreeItem(entry.queryKind === "branch" ? queryLabel(entry.header.identity) : this.text("queryText"),
        entry.queryKind === "branch" ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None);
      item.id = entry.key;
      item.contextValue = entry.queryKind === "branch" ? "eskaQueryDataSet" : "eskaQuery";
      item.iconPath = new vscode.ThemeIcon(entry.queryKind === "branch" ? "database" : "code");
      if (entry.queryKind === "query") item.command = { command: "eska.explorer.openQuery", title: this.text("queryOpen"), arguments: [entry] };
      return item;
    }
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
        if (!entry.directory) item.command = { command: "eska.explorer.openFile", title: this.text("openSource"), arguments: [entry] };
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
    const expanded = this.expanded.get(entry.key) ?? (node.parent ? node.expandedByDefault
      : this.tree?.projects.length === 1 && entry.project.info.scope.kind === "standalone");
    const item = new vscode.TreeItem(label, isModuleLeaf(entry) || (node.parent && node.state === "empty" && !isForm(entry)
      && !(isXmlQueryOwner(entry) && this.connection.state.kind === "ready" && this.connection.state.queryEditing)) ? vscode.TreeItemCollapsibleState.None
      : expanded ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.Collapsed);
    item.id = entry.key;
    item.resourceUri = this.decorations.resource(entry);
    const support = this.support.object(entry);
    item.tooltip = support ? `${label}\n${this.support.explanation(entry)}` : label;
    item.contextValue = !node.parent
      ? supportsRootFilter(entry.project)
        ? this.hideEmptyGroups(entry.project) ? "eskaRootFiltered" : "eskaRootUnfiltered"
        : "eskaRoot"
      : node.id.kind === "collection" ? "eskaMetadataGroup"
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
    if ("queryKind" in entry) return entry.queryKind === "query" ? entry.parent : entry.owner;
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
    const source = uri && ProtectedSources.sourceUri(uri);
    const activeProject = !!source && source.scheme === "file" && !!this.files?.scopes.some(scope =>
      relativeFile(scope.path, source.fsPath) !== undefined);
    void vscode.commands.executeCommand("setContext", "eska.explorer.activeProject", activeProject);
    void vscode.commands.executeCommand("setContext", "eska.explorer.connected", !!this.tree);
  }

  /** Reveal the active source without replacing the document or changing unsaved text. */
  private async revealActiveFile(): Promise<void> {
    const uri = vscode.window.activeTextEditor?.document.uri;
    if (!uri || (uri.scheme !== "file" && uri.scheme !== PROTECTED_SOURCE_SCHEME)) return;
    const source = ProtectedSources.sourceUri(uri);
    if (!this.tree) await this.connect(false);
    const tree = this.tree;
    if (!tree) return;
    try {
      const entry = await revealFile(tree, source.fsPath) ?? await this.files?.reveal(source.fsPath);
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
        // Support updates can repaint ancestors before native expansion events reach the extension host.
        for (let parent = tree.parent(entry); parent; parent = tree.parent(parent)) this.expanded.set(parent.key, true);
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
  private supportRepaint(entries?: TreeEntry[]): void {
    if (entries) {
      if (entries.length) this.changed.fire(entries);
      return;
    }
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

  /** Activate properties or a resolved source, preserving unsaved buffers and rejecting stale positions. */
  private async open(entry: TreeEntry, target: SourceTarget = "default", property?: PropertyChoice): Promise<void> {
    const tree = this.tree;
    if (!tree || !entry || !("node" in entry) || !tree.projects.includes(entry.project)) return;
    const opening = ++this.opening;
    try {
      const source = property ? await resolvePropertySource(tree, entry, property)
        : target === "default" ? await resolveTreeSource(tree, entry) : await resolveSource(tree, entry, target);
      if (opening !== this.opening || tree !== this.tree) return;
      if (!source) {
        await this.showProperties(entry);
        return;
      }
      const uri = await this.support.resolveUri(source.path);
      if (opening !== this.opening || tree !== this.tree) return;
      const document = await vscode.workspace.openTextDocument(uri);
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

  /** Open a dedicated settings-style editor tab for this metadata object. */
  private async showProperties(entry: TreeEntry): Promise<void> {
    const tree = this.tree;
    if (!tree || !entry || entry.node?.id.kind !== "object" || !tree.projects.includes(entry.project)) return;
    // A context-menu or property-tab activation supersedes an earlier asynchronous source open.
    this.opening++;
    try {
      await this.propertiesTabs.show(tree, entry);
    } catch (error) {
      if (tree === this.tree) this.showError(error instanceof ExplorerError ? error : new ExplorerError("requestFailed"));
    }
  }

  /** File groups use the same protected route as metadata nodes. */
  private async openFile(entry: WorkspaceEntry): Promise<void> {
    if (entry?.fileKind !== "entry" || entry.directory || !this.files?.scopes.some(scope =>
      relativeFile(scope.path, entry.path) !== undefined)) return;
    const uri = await this.support.resolveUri(entry.path);
    if (uri.scheme === "file") await vscode.commands.executeCommand("vscode.open", uri);
    else await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(uri), { preview: true });
  }

  /** Restoration waits for the existing process; unclassified views remain rooted read-only previews owned by ESKA. */
  private async readProtectedSource(source: vscode.Uri): Promise<Awaited<ReturnType<SourceAccess['read']>>> {
    for (let attempt = 0; attempt < 3; attempt++) {
      await this.connectionAttempt;
      await this.supportContextsPending;
      if (this.disposed) throw new ExplorerError("obsolete");
      try {
        const view = await this.support.readSource(source.fsPath);
        if (view) return view;
      } catch (error) {
        if (error instanceof ExplorerError && error.domain === "source_view_failed" && error.details?.reason === "unknown_source") break;
        if (!(error instanceof ExplorerError) || attempt === 2
          || (error.domain !== "stale_generation" && error.code !== "sourceChanged")) throw error;
        // Ordered metadata/native events can supersede a readonly capture; retry only that read under its new context.
        await new Promise(resolve => setTimeout(resolve, 0));
        continue;
      }
      break;
    }
    const endpoint = this.connection.sources, target = this.connection.target;
    if (!endpoint || !target) throw new ExplorerError("incompatible");
    const path = relativeFile(target.path, source.fsPath);
    if (!path) throw new ExplorerError("sourceMissing");
    return new SourceAccess(endpoint).preview({ value: path, encoding: "utf-8" });
  }

  /** Invalidate preflight as well as the protocol connection so late probes cannot reconnect. */
  private async disconnect(): Promise<void> {
    this.connecting?.abort();
    this.selecting = false;
    await this.language.stop();
    await this.connection.disconnect();
  }

  /** Connect reuses a single-folder session or its handshake; restart explicitly replaces it. */
  private connect(choose: boolean): Promise<void> {
    if (this.selecting || (choose && ["connecting", "ready"].includes(this.connection.state.kind)
      && this.folders().length === 1 && this.selected?.uri.toString() === this.folders()[0]?.uri.toString())) {
      return this.connectionAttempt;
    }
    this.connectionAttempt = this.openConnection(choose);
    return this.connectionAttempt;
  }

  /** Selection is explicit for unrelated multi-root folders; workspace members are opened by eska. */
  private async openConnection(choose: boolean): Promise<void> {
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
      const backend = this.backendKind();
      const configured = vscode.workspace.getConfiguration("eska.explorer", folder.uri).get<string>("executable", "eska-project");
      const executable = backend === "project" ? await this.tooling.ensureProject(controller.signal, configured)
        : await this.setup.ensure(controller.signal, configured, backend);
      if (!executable || this.disposed || controller.signal.aborted) return;
      if (!this.folders().some(value => value.uri.toString() === folder.uri.toString())) return;
      // Release the picker guard before the asynchronous handshake, allowing disconnect/restart.
      this.selecting = false;
      await this.language.stop();
      if (controller.signal.aborted || this.disposed) return;
      await this.connection.connect({ executable, backend, path: folder.uri.fsPath, name: folder.name,
        locale: vscode.env.language.toLowerCase().startsWith("ru") ? "ru-RU" : "en-US" });
    } catch (error) {
      if (!controller.signal.aborted && !this.disposed) {
        if (error instanceof ToolFailure) this.tooling.report(error);
        else this.showError(error instanceof ExplorerError ? error : new ExplorerError("spawnFailed"));
      }
    } finally { if (this.connecting === controller) this.selecting = false; }
  }

  /** Read workspace folders afresh after pickers or asynchronous lifecycle operations. */
  private folders(): readonly vscode.WorkspaceFolder[] { return vscode.workspace.workspaceFolders ?? []; }

  /** Policy follows backend-resolved application roots without delaying analysis on unrelated folder sessions. */
  private registerLanguagePolicyRoots(roots: readonly string[]): void {
    const next = [...new Set(roots)].sort();
    if (JSON.stringify(next) === JSON.stringify(this.languagePolicyRoots)) return;
    this.languagePolicyRoots = next;
    // Let an existing folder open finish first: its actual projects may already cover the requested member roots.
    void this.supportContextsPending.then(() => this.refreshSupportContexts()).catch(() => {});
  }

  /** Reuse established project scopes; a language edit still fails closed until the targeted backend policy is ready. */
  private refreshSupportContexts(): Promise<void> {
    const state = this.connection.state;
    if (this.disposed || state.kind !== "ready") return this.supportContextsPending;
    const mainRoots = new Set(state.session.projects.map(project => nativePath(project.rootPath)));
    const targets = new Map(this.folders().filter(folder => folder.uri.fsPath !== state.target.path)
      .map(folder => [folder.uri.fsPath, { ...state.target, path: folder.uri.fsPath, name: folder.name }]));
    for (const root of this.languagePolicyRoots) {
      const covered = mainRoots.has(root) || this.additionalPolicyTrees.some(tree => {
        const origin = tree.connection.target?.path;
        return origin !== undefined && targets.has(origin) && tree.projects.some(project => nativePath(project.info.rootPath) === root);
      });
      if (!covered && !targets.has(root)) targets.set(root, { ...state.target, path: root, name: basename(root) });
    }
    if (!this.support.enabled) for (const path of targets.keys()) if (!this.languagePolicyRoots.includes(path)) targets.delete(path);
    const key = JSON.stringify([state.session.sessionId, this.support.enabled, [...targets.keys()].sort()]);
    if (this.supportContextsKey === key) return this.supportContextsPending;
    this.supportContextsKey = key;
    this.supportContextsPending = this.supportContexts.start([...targets.values()], this.languagePolicyRoots.length > 0).catch(error => {
      if (!this.disposed) this.output.warn(JSON.stringify({ event: "support_context_failed", code: error instanceof ExplorerError ? error.code : "requestFailed" }));
    });
    return this.supportContextsPending;
  }

  /** Backend selection changes process arguments and negotiated identity without rewriting a custom path. */
  private backendKind(): BackendKind {
    const value = vscode.workspace.getConfiguration("eska.explorer", this.selected?.uri).get<string>("backend", "project");
    if (value !== "project" && value !== "legacy") throw new ExplorerError("incompatible");
    return value;
  }

  /** Process logs never become the view's labels or user-facing error text. */
  private update(state: ConnectionState): void {
    if (this.disposed) return;
    this.queries.stale();
    this.supportContextsPending = this.supportContexts.stop(); this.supportContextsKey = undefined;
    if (state.kind !== "ready") this.languagePolicyRoots = [];
    this.searchView?.dispose();
    this.propertiesTabs.stale();
    this.tree?.dispose();
    this.files?.dispose();
    this.files = undefined;
    this.tree = undefined;
    for (const watcher of this.watchers) watcher.dispose();
    this.watchers = [];
    this.opening++;
    if (state.kind === "ready") {
      const tree = new MetadataTree(this.connection, state.session,
        (entries) => { this.support.invalidate(); this.decorations.invalidate(); this.propertiesTabs.changed(tree, entries);
          this.protectedSources.refresh();
          void this.repaint(entries); }, (project, reopen) => this.recover(project, reopen));
      this.tree = tree;
      this.files = new WorkspaceFiles(tree.projects, state.target.path, watchDirectory, entry => {
        if (this.tree !== tree) return;
        this.changed.fire(entry && ("fileKind" in entry ? entry : entry.root));
      });
      try {
        for (const project of tree.projects) this.watchers.push(new ProjectWatcher(tree, project,
          (error) => { this.output.info(`watch_error code=${error instanceof ExplorerError ? error.code : "requestFailed"}`); },
          path => this.language.sourceChanged(path)));
        this.watchers.push(watchManifests(state.target.path, tree.projects, () => { void this.connect(false); }, () => this.language.manifestChanged()));
      } catch (error) { this.showError(error instanceof ExplorerError ? error : new ExplorerError("unsupportedPath")); }
    }
    this.support.setTree(this.tree, state.kind === "ready" && state.supportPolicy, state.kind === "disconnected" || state.kind === "stopping", state.kind === "ready" && state.supportFiles);
    this.protectedSources.refresh();
    if (state.kind === "ready") {
      void this.refreshSupportContexts();
    }
    this.decorations.setTree(this.tree);
    this.updateKeyboardContext();
    this.changed.fire(undefined);
    this.tooling.projectConnection(state);
    this.language.connectionChanged(state);
    if (state.kind === "ready") {
      void this.setup.background(state.target.backend ?? "project");
      if (state.target.backend === "legacy" && !this.legacyNotices.has(state.target.executable)) {
        this.legacyNotices.add(state.target.executable);
        void vscode.window.showWarningMessage(this.text("legacyBackendSelected"));
      }
    }
    if (state.kind === "error") this.showError(state.error);
  }

  /** A disconnected component remains visible without claiming a connected or offered version. */
  private renderProjectStatus(): void {
    if (this.disposed) return;
    const state = this.connection.state;
    const operation = Object.values(this.tooling.states).find(tool => tool.activity)?.activity;
    const activity = operation ? ` · ${this.text(`toolPhase_${operation}`)}` : "";
    this.status.text = state.kind === "ready"
      ? this.text(state.target.backend === "legacy" ? "legacyStatus" : "projectStatus", state.version) + activity
      : `ESKA · ${this.text(state.kind === "error" ? "toolPhase_error" : "toolPhase_disconnected")}${activity}`;
    this.status.tooltip = state.kind === "ready" && state.target.backend === "legacy"
      ? `${this.text("statusTooltip", state.version, state.target.executable)}\n\n${this.tooling.summary()}` : this.tooling.summary();
    this.status.show();
  }

  /** Setup instructions are a packaged document, not an automatic init or executable installer. */
  private showError(error: ExplorerError): void {
    const setup = error.code === "manifestMissing" || error.code === "executableMissing" || error.code === "incompatible" || error.code === "handshakeFailed" || error.code === "legacyBackend";
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
      const other = Promise.allSettled([this.formatting.shutdown(), this.supportContexts.stop(), this.support.shutdown(), this.setup.shutdown(), this.tooling.shutdown()]);
      const queries = this.queryDesigner.shutdown().then(() => Promise.allSettled([this.queries.shutdown()]));
      this.stopping = (async () => {
        const language = await Promise.allSettled([this.language.shutdown()]);
        const queryResults = await queries;
        const metadata = await Promise.allSettled([this.connection.dispose()]);
        for (const result of [...language, ...queryResults, ...metadata, ...await other]) if (result.status === "rejected") throw result.reason;
      })().finally(() => this.output.dispose());
    }
    return this.stopping;
  }

  /** The synchronous subscription hook shares cleanup with the awaited deactivate hook. */
  dispose(): void { void this.shutdown(); }
}
