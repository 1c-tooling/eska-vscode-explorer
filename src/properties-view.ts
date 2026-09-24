import * as vscode from "vscode";
import { message } from "./messages.js";
import { ExplorerError, isRecord } from "./protocol.js";
import { objectSynonym, propertyChoices, RUSSIAN_PROPERTY_NAMES, type PropertyChoice } from "./properties.js";
import { nodeKey, type MetadataTree, type TreeEntry } from "./tree.js";

type Language = "ru-RU" | "en-US";

interface ViewState {
  type: "state";
  title: string;
  path: string;
  status: "loading" | "ready" | "stale" | "error";
  notice: string;
  labels: Record<string, string>;
  names: Readonly<Record<string, string>>;
  properties: Pick<PropertyChoice, "index" | "label" | "key" | "qualifiers" | "value" | "description">[];
}

/** One editor tab belongs to one project-scoped metadata identity. */
class PropertyTab implements vscode.Disposable {
  readonly panel: vscode.WebviewPanel;
  private choices: PropertyChoice[] = [];
  private ready = false;
  private disposed = false;
  private revision = 0;
  private controller: AbortController | undefined;
  private state: ViewState;

  constructor(private readonly context: vscode.ExtensionContext, private tree: MetadataTree, private entry: TreeEntry,
    private readonly language: () => Language, private readonly currentTree: () => MetadataTree | undefined,
    private readonly openXml: (entry: TreeEntry, choice: PropertyChoice) => Promise<void>,
    private readonly closed: () => void) {
    const roots = [vscode.Uri.joinPath(context.extensionUri, "resources", "properties")];
    const label = entry.node.label.kind === "name" ? entry.node.label.text : entry.node.label.translations[language()];
    const title = `${label} · ${message(vscode.env.language, "properties")}`;
    this.panel = vscode.window.createWebviewPanel("eska.explorer.properties", title, vscode.ViewColumn.Active,
      { enableScripts: true, localResourceRoots: roots });
    this.state = this.makeState("loading", message(vscode.env.language, "propertyLoading"));
    this.panel.webview.html = this.html();
    this.panel.onDidDispose(() => this.dispose());
    this.panel.onDidChangeViewState(() => {
      if (this.panel.visible && this.state.status === "ready" && this.tree === this.currentTree()) void this.load();
    });
    this.panel.webview.onDidReceiveMessage((input: unknown) => { void this.receive(input); });
    this.updateTitle();
  }

  /** Existing object tabs return to focus and bind to the freshest tree entry. */
  bind(tree: MetadataTree, entry: TreeEntry): void {
    this.tree = tree;
    this.entry = entry;
    this.updateTitle();
    this.panel.reveal(this.panel.viewColumn);
  }

  /** Invalidation refreshes only visible tabs bound to the affected project. */
  matches(tree: MetadataTree, entries: TreeEntry[] | undefined): boolean {
    return this.tree === tree && this.panel.visible
      && (!entries || entries.some(entry => entry.project === this.entry.project));
  }

  /** Show the current status again when VS Code recreates a hidden webview. */
  private publish(): void {
    if (this.ready && !this.disposed) void this.panel.webview.postMessage(this.state);
  }

  /** Read only this object's properties and ignore requests superseded by refresh or disposal. */
  async load(): Promise<void> {
    this.controller?.abort();
    const controller = new AbortController();
    this.controller = controller;
    const revision = ++this.revision;
    const tree = this.tree;
    const entry = this.entry;
    this.state = this.makeState("loading", message(vscode.env.language, "propertyLoading"));
    this.publish();
    try {
      if (tree !== this.currentTree() || entry.project.nodes.get(nodeKey(entry.node.id)) !== entry
        || entry.node.id.kind !== "object") throw new ExplorerError("obsolete");
      const result = await tree.request(entry.project, "metadata/properties", { objectId: entry.node.id.objectId }, controller.signal);
      if (controller.signal.aborted || this.disposed || revision !== this.revision) return;
      if (tree !== this.currentTree() || entry.project.nodes.get(nodeKey(entry.node.id)) !== entry) throw new ExplorerError("obsolete");
      this.choices = propertyChoices(result, vscode.env.language);
      this.updateTitle();
      this.state = this.makeState("ready", "");
      this.publish();
    } catch (error) {
      if (controller.signal.aborted || this.disposed || revision !== this.revision) return;
      const failure = error instanceof ExplorerError ? error : new ExplorerError("requestFailed");
      this.choices = [];
      this.updateTitle();
      this.state = this.makeState(failure.code === "obsolete" ? "stale" : "error", message(vscode.env.language,
        failure.code === "obsolete" ? "propertyStale" : failure.code));
      this.publish();
    }
  }

  /** Connection replacement leaves the tab visible but prevents stale XML navigation. */
  stale(): void {
    this.controller?.abort();
    this.revision++;
    this.choices = [];
    this.updateTitle();
    this.state = this.makeState("stale", message(vscode.env.language, "propertyStale"));
    this.publish();
  }

  /** Recompute visible labels after a tree-language change. */
  relabel(): void {
    this.updateTitle();
    this.state = this.makeState(this.state.status, this.state.notice);
    this.publish();
  }

  /** Route only known message types and stored property indexes from the isolated webview. */
  private async receive(input: unknown): Promise<void> {
    if (!isRecord(input) || this.disposed) return;
    if (input.type === "ready") {
      this.ready = true;
      this.publish();
    } else if (input.type === "refresh") {
      await this.load();
    } else if (input.type === "openXml" && Number.isSafeInteger(input.index)) {
      const choice = this.choices[input.index as number];
      if (choice && this.state.status === "ready" && this.tree === this.currentTree()) {
        await this.openXml(this.entry, choice);
      }
    }
  }

  /** The tab title and breadcrumb identify same-named objects in different projects. */
  private heading(): { title: string; path: string } {
    const names: string[] = [];
    let cursor: TreeEntry | undefined = this.entry;
    for (let depth = 0; cursor && depth < 64; depth++) {
      const label = cursor.node.label;
      names.unshift(label.kind === "name" ? label.text : label.translations[this.language()]);
      cursor = this.tree.parent(cursor);
    }
    const project = this.entry.project.info.scope.kind === "member" ? this.entry.project.info.scope.name
      : this.tree.connection.target?.name ?? message(vscode.env.language, this.entry.project.info.type);
    return { title: objectSynonym(this.choices, this.language()) ?? names.at(-1) ?? message(vscode.env.language, "properties"),
      path: [project, ...names.slice(0, -1)].join(" › ") };
  }

  /** Keep the native editor tab title synchronized with the tree language. */
  private updateTitle(): void {
    this.panel.title = `${this.heading().title} · ${message(vscode.env.language, "properties")}`;
  }

  /** Keep presentation text local to the host while passing structured values as data. */
  private makeState(status: ViewState["status"], notice: string): ViewState {
    const heading = this.heading();
    const text = (key: Parameters<typeof message>[1], ...values: string[]): string => message(vscode.env.language, key, ...values);
    return {
      type: "state", title: heading.title, path: heading.path, status, notice,
      names: this.language() === "ru-RU" ? RUSSIAN_PROPERTY_NAMES : {},
      labels: {
        properties: text("properties"), search: text("propertySearch"), refresh: text("propertyRefresh"),
        openXml: text("openXml"), empty: text("propertyEmpty"), noMatches: text("propertyNoMatches"),
        readOnly: text("propertyReadOnly"), fields: text("propertyFields", "{0}"),
        xmlOnly: text("propertyXmlOnly"), count: text("propertyCount", "{0}"),
      },
      properties: this.choices.map(({ index, label, key, qualifiers, value, description }) =>
        ({ index, label, key, qualifiers, value, description })),
    };
  }

  /** Package local CSS/JS with a strict CSP; workspace text reaches the DOM only via textContent. */
  private html(): string {
    const webview = this.panel.webview;
    const css = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, "resources", "properties", "view.css"));
    const script = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, "resources", "properties", "view.js"));
    const lang = vscode.env.language.toLowerCase().startsWith("ru") ? "ru" : "en";
    return `<!doctype html><html lang="${lang}"><head><meta charset="utf-8">
      <meta name="viewport" content="width=device-width, initial-scale=1">
      <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; script-src ${webview.cspSource};">
      <link rel="stylesheet" href="${css}"><title>ESKA Properties</title></head>
      <body><main class="page"><header class="heading"><div id="breadcrumb" class="breadcrumb"></div>
      <div class="title-row"><h1 id="title"></h1><span id="read-only" class="badge"></span></div></header>
      <div class="toolbar"><label class="visually-hidden" for="search"></label>
      <input id="search" type="search" autocomplete="off"><button id="refresh" type="button"></button></div>
      <p id="count" class="count" aria-live="polite"></p><p id="notice" class="notice" role="status"></p>
      <section id="items" class="items" aria-label="Properties"></section></main>
      <script src="${script}"></script></body></html>`;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.controller?.abort();
    this.panel.dispose();
    this.closed();
  }
}

/** The map reuses one tab per object and leaves other objects in separate editor tabs. */
export class PropertyTabs implements vscode.Disposable {
  private readonly tabs = new Map<string, PropertyTab>();

  constructor(private readonly context: vscode.ExtensionContext, private readonly language: () => Language,
    private readonly currentTree: () => MetadataTree | undefined,
    private readonly openXml: (entry: TreeEntry, choice: PropertyChoice) => Promise<void>) {}

  async show(tree: MetadataTree, entry: TreeEntry): Promise<void> {
    if (entry.node.id.kind !== "object") return;
    const key = JSON.stringify([entry.project.key, entry.node.id.objectId]);
    let tab = this.tabs.get(key);
    if (tab) tab.bind(tree, entry);
    else {
      tab = new PropertyTab(this.context, tree, entry, this.language, this.currentTree, this.openXml,
        () => { this.tabs.delete(key); });
      this.tabs.set(key, tab);
    }
    await tab.load();
  }

  /** Keep open tabs but flag their data when the connection is replaced. */
  stale(): void { for (const tab of this.tabs.values()) tab.stale(); }

  /** Visible tabs refresh when the backend invalidates their project. */
  changed(tree: MetadataTree, entries: TreeEntry[] | undefined): void {
    for (const tab of this.tabs.values()) {
      if (tab.matches(tree, entries)) void tab.load();
    }
  }

  relabel(): void { for (const tab of this.tabs.values()) tab.relabel(); }

  dispose(): void {
    for (const tab of [...this.tabs.values()]) tab.dispose();
    this.tabs.clear();
  }
}
