import * as vscode from "vscode";
import { Connection, type ConnectionState } from "./connection.js";
import { assertHost } from "./host.js";
import { message, type MessageKey } from "./messages.js";
import { ExplorerError } from "./protocol.js";

let active: Explorer | undefined;

/** Activation registers only Explorer UI; no backend runs before a view or command needs it. */
export function activate(context: vscode.ExtensionContext): void {
  active = new Explorer(context);
  context.subscriptions.push(active);
}

/** VS Code awaits this promise before unloading the extension host. */
export async function deactivate(): Promise<void> {
  await active?.shutdown();
  active = undefined;
}

/** A connection view intentionally has no XML parsing or metadata schema. */
class Explorer implements vscode.TreeDataProvider<vscode.TreeItem>, vscode.Disposable {
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.changed.event;
  private readonly output = vscode.window.createOutputChannel("eska Explorer");
  private readonly connection: Connection;
  private readonly view: vscode.TreeView<vscode.TreeItem>;
  private readonly disposables: vscode.Disposable[] = [];
  private selected: vscode.WorkspaceFolder | undefined;
  private attempted = false;
  private selecting = false;
  private disposed = false;
  private stopping: Promise<void> | undefined;

  constructor(private readonly context: vscode.ExtensionContext) {
    this.connection = new Connection(String(context.extension.packageJSON.version),
      (state) => this.update(state), (text) => this.output.appendLine(text));
    this.view = vscode.window.createTreeView("eska.explorer.projects", { treeDataProvider: this });
    for (const [name, action] of [
      ["connect", () => this.connect(true)],
      ["restart", () => this.connect(false)],
      ["disconnect", () => this.connection.disconnect()],
      ["showLog", () => this.output.show(true)],
    ] as const) {
      this.disposables.push(vscode.commands.registerCommand(`eska.explorer.${name}`, action));
    }
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
    }));
    if (this.view.visible) void this.connect(false);
  }

  /** Resolve the active host locale without changing the workspace's language providers. */
  private text(key: MessageKey, ...values: string[]): string { return message(vscode.env.language, key, ...values); }

  /** The UI displays backend-returned members without discovering or parsing manifests itself. */
  getChildren(): vscode.TreeItem[] {
    const state = this.connection.state;
    if (state.kind === "ready") {
      return state.session.projects.map((project) => {
        const item = new vscode.TreeItem(project.scope.kind === "member" ? project.scope.name : state.target.name);
        item.id = `${state.session.sessionId}:${project.projectId}`;
        item.description = this.text(project.type);
        item.tooltip = project.rootPath.value;
        item.iconPath = new vscode.ThemeIcon("project");
        return item;
      });
    }
    const item = new vscode.TreeItem(this.text(state.kind === "error" ? state.error.code : state.kind));
    item.tooltip = item.label as string;
    if (state.kind === "disconnected" || state.kind === "error") {
      item.command = { command: "eska.explorer.connect", title: this.text("select") };
    }
    item.iconPath = new vscode.ThemeIcon(state.kind === "error" ? "warning" : "info");
    return [item];
  }

  /** Items are already native TreeItems; no mutable UI cache is required at this stage. */
  getTreeItem(item: vscode.TreeItem): vscode.TreeItem { return item; }

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
    this.changed.fire();
    this.view.message = state.kind === "ready" ? this.text("ready", state.version) : "";
    if (state.kind === "error") this.showError(state.error);
  }

  /** Setup instructions are a packaged document, not an automatic init or executable installer. */
  private showError(error: ExplorerError): void {
    const setup = error.code === "manifestMissing" || error.code === "executableMissing" || error.code === "incompatible";
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
      this.view.dispose();
      this.changed.dispose();
      this.stopping = this.connection.dispose().finally(() => this.output.dispose());
    }
    return this.stopping;
  }

  /** The synchronous subscription hook shares cleanup with the awaited deactivate hook. */
  dispose(): void { void this.shutdown(); }
}
