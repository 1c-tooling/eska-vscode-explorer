import * as vscode from "vscode";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { ExplorerError } from "../protocol.js";
import { existingSource } from "../source.js";
import { revealFile } from "../reveal.js";
import { nodeKey, type MetadataTree, type TreeEntry } from "../tree.js";
import { message, type MessageKey } from "../messages.js";
import { QueryClient, queryKey, querySnapshot, type QueryDocument } from "./client.js";
import { xmlQueryOwner, sourceHash, type XmlQueryOwner } from "./owner.js";
import { QueryRecovery, type QueryDraftRecord } from "./recovery.js";
import type { QueryHeader, QueryIdentity } from "./protocol.js";

export const QUERY_SCHEME = "eska-query";
interface Session {
  record: QueryDraftRecord;
  resumed: boolean;
  mtime: number;
  saving?: Promise<void>;
}

/** Editable SDBL views own private drafts; only a freshly checked backend plan can change XML. */
export class QueryTabs implements vscode.FileSystemProvider {
  private readonly events = new vscode.EventEmitter<vscode.FileChangeEvent[]>();
  readonly onDidChangeFile = this.events.event;
  private readonly sessions = new Map<string, Session>();
  private readonly gates = new Map<string, Promise<unknown>>();
  private readonly recovery: QueryRecovery;
  private readonly ready: Promise<void>;
  private readonly subscriptions: vscode.Disposable[];
  private disposed = false;

  constructor(context: vscode.ExtensionContext, private readonly currentTree: () => MetadataTree | undefined,
    private readonly application: () => string | undefined, private readonly changed: (entry: TreeEntry) => void,
    private readonly log: (value: string) => void) {
    this.recovery = new QueryRecovery(join(context.globalStorageUri.fsPath, "query-drafts-v1"), () => {
      void vscode.window.showWarningMessage(this.text("queryRecoveryDamaged"));
    });
    this.ready = this.load();
    void this.ready.catch(error => this.failure(error));
    this.subscriptions = [vscode.workspace.registerFileSystemProvider(QUERY_SCHEME, this, { isCaseSensitive: true }),
      vscode.workspace.onDidChangeTextDocument(event => {
        const session = this.session(event.document.uri);
        if (session && !this.isOwnerSnapshot(event.document.uri) && !this.disposed) {
          session.record = { ...session.record, draft: canonical(event.document.getText()) };
          void this.recovery.save(session.record).catch(error => this.failure(error));
        }
      }), vscode.workspace.onDidOpenTextDocument(document => {
        if (document.uri.scheme === QUERY_SCHEME) void this.restore(document).catch(error => this.failure(error));
      }), vscode.workspace.onDidCloseTextDocument(document => {
        this.closeView(document.uri);
      }), vscode.window.tabGroups.onDidChangeTabs(event => {
        for (const tab of event.closed) if (tab.input instanceof vscode.TabInputText) this.closeView(tab.input.uri);
      })];
  }

  /** XML discovery is lazy, uses the current editor buffer, and releases every transient backend document. */
  async discover(tree: MetadataTree, entry: TreeEntry): Promise<QueryHeader[]> {
    return this.serial(entry.key, async () => {
      const owner = await xmlQueryOwner(tree, entry);
      if (!owner) return [];
      return this.withDocument(tree, owner, async document => document.list());
    });
  }

  /** Focus an existing session or close its previous query through the editor's native dirty-close prompt. */
  async show(tree: MetadataTree, entry: TreeEntry, identity: QueryIdentity): Promise<void> {
    await this.ready;
    await this.serial(entry.key, async () => {
      const owner = await xmlQueryOwner(tree, entry);
      if (!owner) throw new ExplorerError("sourceMissing");
      const existing = [...this.sessions.values()].find(session => session.record.projectKey === entry.project.key
        && nodeKey(session.record.node) === nodeKey(entry.node.id));
      if (existing) {
        if (queryKey(existing.record.identity) === queryKey(identity)) { await this.focus(existing); return; }
        if (existing.record.draft !== existing.record.base) await this.focus(existing);
        const tabs = vscode.window.tabGroups.all.flatMap(group => group.tabs).filter(tab => tab.input instanceof vscode.TabInputText
          && tab.input.uri.toString() === this.uri(existing.record).toString());
        if (tabs.length && !await vscode.window.tabGroups.close(tabs)) return;
        this.sessions.delete(existing.record.id);
        await this.recovery.remove(existing.record.id);
      }
      const session = await this.withDocument(tree, owner, async document => {
        const query = await document.read({ query: identity });
        if (canonical(query.text) !== query.text) throw new ExplorerError("requestFailed", "query_failed", { reason: "unsupported_structure" });
        return { resumed: true, mtime: Date.now(), record: {
          schemaVersion: 1 as const, id: randomUUID(), projectKey: entry.project.key, node: entry.node.id,
          source: owner.source, descriptor: owner.descriptor, descriptorSnapshot: owner.descriptorSnapshot,
          diskSnapshot: document.diskSnapshot, ownerSnapshot: document.binding.snapshot, ownerText: document.original,
          ownerVersion: document.binding.version, contextFingerprint: document.binding.contextFingerprint,
          application: document.application, identity, base: query.text, draft: query.text, writable: document.writable,
        } };
      });
      await this.recovery.save(session.record);
      this.sessions.set(session.record.id, session);
      await this.focus(session);
    });
  }

  /** Explicit resumption prevents autosave from applying a recovered draft before owner/context verification. */
  async resume(uri = vscode.window.activeTextEditor?.document.uri): Promise<void> {
    await this.ready;
    const session = uri && this.session(uri);
    if (!session) return;
    const tree = this.currentTree();
    if (!tree) throw new ExplorerError("obsolete");
    const selection = this.application();
    const owner = await this.checkedOwner(tree, session, true);
    await this.withDocument(tree, owner, async document => this.checkBinding(session, document, owner.diskSnapshot));
    if (tree !== this.currentTree() || selection !== this.application()
      || querySnapshot(owner.document.getText()) !== session.record.ownerSnapshot) throw new ExplorerError("sourceChanged");
    session.record = { ...session.record, ownerVersion: String(owner.document.version), diskSnapshot: owner.diskSnapshot };
    session.resumed = true;
    await this.recovery.save(session.record);
    await this.focus(session);
  }

  /** A connection replacement cannot reuse an earlier owner's authority. Draft text remains available. */
  stale(): void { for (const session of this.sessions.values()) session.resumed = false; }

  /** Expose the retained dirty-owner snapshot for review without making it a project source. */
  async compare(uri = vscode.window.activeTextEditor?.document.uri): Promise<void> {
    await this.ready;
    const session = uri && this.session(uri);
    if (!session) return;
    const snapshot = this.uri(session.record).with({ path: `/${session.record.id}/owner.xml` });
    const project = this.currentTree()?.projects.find(project => project.key === session.record.projectKey);
    if (!project) { await vscode.window.showTextDocument(snapshot, { preview: false }); return; }
    try {
      const path = await existingSource(project.info.sourcePath, session.record.source);
      await vscode.commands.executeCommand("vscode.diff", snapshot, vscode.Uri.file(path), this.text("queryCompare"));
    } catch { await vscode.window.showTextDocument(snapshot, { preview: false }); }
  }

  /** Query-specific machine reasons stay distinct from generic metadata operation errors. */
  explain(error: unknown): void { this.failure(error); }

  /** VS Code owns the editor model; the provider exposes only its last saved checkpoint. */
  async readFile(uri: vscode.Uri): Promise<Uint8Array> {
    await this.ready;
    const session = this.required(uri);
    return Buffer.from(this.isOwnerSnapshot(uri) ? session.record.ownerText : session.record.base);
  }

  /** Provider metadata never delegates a writable native source URI. */
  async stat(uri: vscode.Uri): Promise<vscode.FileStat> {
    await this.ready;
    const session = this.required(uri);
    return { type: vscode.FileType.File, ctime: 1, mtime: session.mtime,
      size: Buffer.byteLength(this.isOwnerSnapshot(uri) ? session.record.ownerText : session.record.base),
      ...(!session.record.writable || this.isOwnerSnapshot(uri) ? { permissions: vscode.FilePermission.Readonly } : {}) };
  }

  /** Save changes only the selected query; an already dirty owner remains unsaved. */
  async writeFile(uri: vscode.Uri, content: Uint8Array): Promise<void> {
    await this.ready;
    const session = this.required(uri);
    if (this.isOwnerSnapshot(uri) || !session.record.writable) throw vscode.FileSystemError.NoPermissions(this.text("queryReadonly"));
    if (!session.resumed) throw vscode.FileSystemError.Unavailable(this.text("queryResumeRequired"));
    const draft = canonical(new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(content));
    if (session.saving) await session.saving;
    const saving = this.save(session, draft);
    session.saving = saving;
    try { await saving; }
    catch (error) {
      session.resumed = false;
      this.failure(error);
      throw vscode.FileSystemError.Unavailable(this.text("querySaveFailed"));
    } finally { if (session.saving === saving) delete session.saving; }
  }

  /** Session files are flat and cannot be moved into project sources by filesystem mutations. */
  readDirectory(): [string, vscode.FileType][] { return []; }
  /** In-memory watches share the same text document across split editors. */
  watch(): vscode.Disposable { return new vscode.Disposable(() => {}); }
  /** Native folders are never created by the virtual provider. */
  createDirectory(uri: vscode.Uri): void { throw vscode.FileSystemError.NoPermissions(uri); }
  /** Closing a tab owns recovery removal; direct filesystem deletion is refused. */
  delete(uri: vscode.Uri): void { throw vscode.FileSystemError.NoPermissions(uri); }
  /** A URI change would break the checked owner binding. */
  rename(uri: vscode.Uri): void { throw vscode.FileSystemError.NoPermissions(uri); }

  /** Finish source saves and private storage before the metadata connection is stopped. */
  async shutdown(): Promise<void> {
    this.disposed = true;
    try {
      await this.ready;
      await Promise.allSettled([...this.sessions.values()].map(session => session.saving));
      await this.recovery.settled();
    } finally {
      for (const subscription of this.subscriptions) subscription.dispose();
      this.events.dispose();
    }
  }

  /** Recover private records without resolving or applying their owners. */
  private async load(): Promise<void> {
    for (const record of await this.recovery.records()) this.sessions.set(record.id, { record, resumed: false, mtime: Date.now() });
  }

  /** A cached TextDocument may outlive its last tab; only a live view keeps a clean session active. */
  private closeView(uri: vscode.Uri): void {
    if (this.disposed || this.isOwnerSnapshot(uri)) return;
    const session = this.session(uri);
    if (!session || vscode.window.tabGroups.all.some(group => group.tabs.some(tab => tab.input instanceof vscode.TabInputText
      && tab.input.uri.toString() === uri.toString()))) return;
    if (session.record.draft !== session.record.base) {
      session.resumed = false;
      void this.recovery.save(session.record).catch(error => this.failure(error));
      return;
    }
    this.sessions.delete(session.record.id);
    this.events.fire([{ type: vscode.FileChangeType.Deleted, uri }]);
    void this.recovery.remove(session.record.id).catch(error => this.failure(error));
  }

  /** Hot-exit text wins over an older private record; otherwise restore through a real dirty editor edit. */
  private async restore(document: vscode.TextDocument): Promise<void> {
    await this.serial(document.uri.toString(), () => this.restoreOnce(document));
  }

  /** Open and focus callbacks must not submit the same restoration edit concurrently. */
  private async restoreOnce(document: vscode.TextDocument): Promise<void> {
    await this.ready;
    const session = this.session(document.uri);
    if (this.disposed || !session || this.isOwnerSnapshot(document.uri) || document.isClosed || canonical(document.getText()) !== session.record.base
      || session.record.draft === session.record.base) return;
    const edit = new vscode.WorkspaceEdit();
    edit.replace(document.uri, new vscode.Range(document.positionAt(0), document.positionAt(document.getText().length)), session.record.draft);
    if (!await vscode.workspace.applyEdit(edit)) throw new ExplorerError("sourceChanged");
  }

  /** The byte plan and projected map must describe exactly the resulting live owner model. */
  private async save(session: Session, draft: string): Promise<void> {
    const tree = this.currentTree();
    if (!tree || this.disposed) throw new ExplorerError("obsolete");
    const selection = this.application();
    const owner = await this.checkedOwner(tree, session);
    await this.withDocument(tree, owner, async document => {
      await this.checkBinding(session, document);
      const plan = await document.plan(session.record.identity, draft, [],
        { lineEnding: owner.document.eol === vscode.EndOfLine.CRLF ? "crlf" : "lf" });
      if (await sourceHash(owner.path) !== session.record.diskSnapshot
        || await sourceHash(owner.descriptorPath) !== session.record.descriptorSnapshot) throw new ExplorerError("sourceChanged");
      this.assertOwner(session, owner);
      if (this.disposed || tree !== this.currentTree() || !session.resumed || selection !== this.application()) throw new ExplorerError("obsolete");
      const wasDirty = owner.document.isDirty;
      if (!plan.noOp) {
        const edit = new vscode.WorkspaceEdit();
        for (const replacement of plan.replacements) edit.replace(owner.document.uri,
          new vscode.Range(replacement.rangeUtf16.start.line, replacement.rangeUtf16.start.character,
            replacement.rangeUtf16.end.line, replacement.rangeUtf16.end.character), replacement.text);
        if (!await vscode.workspace.applyEdit(edit)) throw new ExplorerError("sourceChanged");
        if (querySnapshot(owner.document.getText()) !== plan.outputSnapshot) throw new ExplorerError("sourceChanged");
        if (!wasDirty && !await owner.document.save()) throw new ExplorerError("sourceChanged");
      }
      if (querySnapshot(owner.document.getText()) !== plan.outputSnapshot) throw new ExplorerError("sourceChanged");
      const output = owner.document.getText();
      const version = String(owner.document.version);
      const diskSnapshot = wasDirty || plan.noOp ? session.record.diskSnapshot : await sourceHash(owner.path);
      if (!wasDirty && !plan.noOp && diskSnapshot !== querySnapshot((owner.bom ? "\ufeff" : "") + output)) {
        throw new ExplorerError("sourceChanged");
      }
      session.record = { ...session.record, base: draft, ownerText: output,
        ownerSnapshot: plan.outputSnapshot, ownerVersion: version, diskSnapshot };
      session.mtime++;
      await this.recovery.save(session.record);
      this.changed(owner.entry);
    });
  }

  /** A new backend document never replaces a previous owner, disk, descriptor or application snapshot silently. */
  private async checkedOwner(tree: MetadataTree, session: Session, restart = false): Promise<XmlQueryOwner & { diskSnapshot: string }> {
    const record = session.record;
    const project = tree.projects.find(project => project.key === record.projectKey);
    if (!project) throw new ExplorerError("sourceChanged");
    const path = await existingSource(project.info.sourcePath, record.source);
    const found = await revealFile(tree, path);
    const entry = found && ("owner" in found ? found.owner : found);
    if (!entry || nodeKey(entry.node.id) !== nodeKey(record.node)) throw new ExplorerError("sourceChanged");
    const owner = await xmlQueryOwner(tree, entry);
    const diskSnapshot = await sourceHash(path);
    if (!owner || owner.path !== path || owner.descriptorSnapshot !== record.descriptorSnapshot
      || querySnapshot(owner.document.getText()) !== record.ownerSnapshot) {
      throw new ExplorerError("sourceChanged");
    }
    // Explicit resumption can acknowledge a manual XML save only when every current disk byte
    // matches the already checked owner buffer. Unrelated external edits still stop the session.
    if (diskSnapshot !== record.diskSnapshot && (!restart || owner.document.isDirty
      || diskSnapshot !== querySnapshot((owner.bom ? "\ufeff" : "") + record.ownerText))) throw new ExplorerError("sourceChanged");
    if (!restart) this.assertOwner(session, owner);
    return { ...owner, diskSnapshot };
  }

  /** Check the live editor again after every asynchronous source or context operation. */
  private assertOwner(session: Session, owner: XmlQueryOwner): void {
    if (owner.document.isClosed || String(owner.document.version) !== session.record.ownerVersion
      || owner.document.getText() !== session.record.ownerText) throw new ExplorerError("sourceChanged");
  }

  /** Both independent backend bindings must still identify the original checked session. */
  private async checkBinding(session: Session, document: QueryDocument, diskSnapshot = session.record.diskSnapshot): Promise<void> {
    if (document.binding.contextFingerprint !== session.record.contextFingerprint
      || document.diskSnapshot !== diskSnapshot || document.binding.snapshot !== session.record.ownerSnapshot
      || !document.writable || !session.record.writable) throw new ExplorerError("sourceChanged");
    const selected = await document.read({ query: session.record.identity });
    if (selected.text !== session.record.base) throw new ExplorerError("sourceChanged");
  }

  /** No document handle survives discovery, save, cancellation or a thrown callback. */
  private async withDocument<T>(tree: MetadataTree, owner: XmlQueryOwner, action: (document: QueryDocument) => Promise<T>): Promise<T> {
    const state = tree.connection.state;
    if (tree !== this.currentTree() || state.kind !== "ready" || !state.queryEditing) throw new ExplorerError("incompatible");
    const client = new QueryClient(tree.connection, tree.session.sessionId, owner.entry.project, state.queryEditing);
    const application = this.application();
    const document = await client.open({ node: owner.entry.node.id, source: owner.source,
      version: String(owner.document.version), text: owner.document.getText(), ...(application ? { application } : {}) });
    try {
      if (!owner.document.isDirty && document.diskSnapshot !== querySnapshot((owner.bom ? "\ufeff" : "") + document.original)) {
        throw new ExplorerError("sourceChanged");
      }
      return await action(document);
    }
    finally { await document.close(); }
  }

  /** Serialize discovery/open for the same owner instead of allocating duplicate backend snapshots. */
  private async serial<T>(key: string, action: () => Promise<T>): Promise<T> {
    const previous = this.gates.get(key);
    const pending = (previous ?? Promise.resolve()).catch(() => {}).then(action);
    this.gates.set(key, pending);
    try { return await pending; }
    finally { if (this.gates.get(key) === pending) this.gates.delete(key); }
  }

  /** A stable private URI gives native SDBL highlighting, shared splits and built-in Undo/Redo. */
  private async focus(session: Session): Promise<void> {
    const document = await vscode.workspace.openTextDocument(this.uri(session.record));
    await this.restore(document);
    await vscode.window.showTextDocument(document, { preview: false });
    if (canonical(document.getText()) !== session.record.base && canonical(document.getText()) !== session.record.draft) {
      throw new ExplorerError("sourceChanged");
    }
  }

  /** Identities appear only in the filename label; the UUID owns the actual session. */
  private uri(record: QueryDraftRecord): vscode.Uri {
    const identity = record.identity;
    const label = identity.kind === "dataSet" ? identity.path.join(".") : identity.kind === "dynamicList" ? identity.name : "query";
    const name = [...label.replaceAll(/[\\/\?#%]/g, "_")].slice(0, 80).join("");
    return vscode.Uri.from({ scheme: QUERY_SCHEME, path: `/${record.id}/${name}.sdbl` });
  }

  /** Read-only original snapshots share the provider without acquiring native source write permissions. */
  private isOwnerSnapshot(uri: vscode.Uri): boolean { return uri.path.split("/")[2] === "owner.xml"; }

  /** Only exact session filenames and original snapshots are readable; arbitrary URI paths are refused. */
  private session(uri: vscode.Uri): Session | undefined {
    if (uri.scheme !== QUERY_SCHEME) return undefined;
    const id = uri.path.split("/")[1];
    const session = id ? this.sessions.get(id) : undefined;
    return session && (this.uri(session.record).toString() === uri.toString()
      || (uri.path === `/${id}/owner.xml` && !uri.authority && !uri.query && !uri.fragment)) ? session : undefined;
  }

  /** Missing private records cannot fall back to any file on disk. */
  private required(uri: vscode.Uri): Session {
    const session = this.session(uri);
    if (!session) throw vscode.FileSystemError.FileNotFound(uri);
    return session;
  }

  /** Technical reasons stay in diagnostics; presentation always has both supported locales. */
  private failure(error: unknown): void {
    this.log(`query_error code=${error instanceof ExplorerError ? error.code : "io"} kind=${error instanceof ExplorerError ? error.domain ?? "none" : "none"}`);
    const reason = error instanceof ExplorerError ? error.details?.reason : undefined;
    const key = error instanceof ExplorerError && error.code === "incompatible" ? "queryUnavailable"
      : reason === "read_only" ? "queryReadonly" : reason === "comments_require_decision" ? "queryComments" : "querySaveFailed";
    if (!this.disposed) void vscode.window.showWarningMessage(this.text(key));
  }

  /** Localize only UI, never persisted identities or protocol fields. */
  private text(key: MessageKey): string { return message(vscode.env.language, key); }
}

/** SDBL editor line endings are logical LF; source physical lines are chosen separately in query/plan. */
function canonical(text: string): string { return text.replaceAll("\r\n", "\n").replaceAll("\r", "\n"); }
