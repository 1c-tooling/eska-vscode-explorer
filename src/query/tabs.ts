import * as vscode from "vscode";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { Connection } from "../connection.js";
import { ExplorerError } from "../protocol.js";
import { existingSource } from "../source.js";
import { configuredReadOnly } from "../editor-policy.js";
import { ProtectedSources } from "../protected-source.js";
import { nodeKey, type MetadataTree, type ProjectTree, type TreeEntry } from "../tree.js";
import { message, type MessageKey } from "../messages.js";
import { QueryClient, queryKey, querySnapshot, type QueryDocument } from "./client.js";
import { xmlQueryOwner, bslQueryOwner, nativeReadOnly, nativeDirty, type QueryOwnerView } from "./owner.js";
import { QueryRecovery, type QueryDraftRecord } from "./recovery.js";
import type { QueryHeader, QueryIdentity } from "./protocol.js";
import type { RecoveryEndpoint } from "./recovery-protocol.js";
import { QuerySessions, type QuerySourceSession } from "./sessions.js";
import type { QueryOwnerFacts } from "./session-protocol.js";
import type { QueryLanguageProjection } from "./projections.js";

export const QUERY_SCHEME = "eska-query";
interface Session {
  record: QueryDraftRecord;
  resumed: boolean;
  mtime: number;
  saving?: Promise<void>;
  source?: QuerySourceSession;
  endpoint?: RecoveryEndpoint;
  pending?: boolean;
  ownerMtime?: number;
  ending?: boolean;
  closing?: Promise<void>;
}

/** Editable SDBL views own private drafts; only a freshly checked backend plan can change their owner. */
export class QueryTabs implements vscode.FileSystemProvider {
  private readonly events = new vscode.EventEmitter<vscode.FileChangeEvent[]>();
  readonly onDidChangeFile = this.events.event;
  private readonly languageEvents = new vscode.EventEmitter<vscode.Uri | undefined>();
  readonly onDidChangeLanguage = this.languageEvents.event;
  private readonly sessions = new Map<string, Session>();
  private readonly removals = new Set<string>();
  private readonly gates = new Map<string, Promise<unknown>>();
  private recovery: QueryRecovery | undefined;
  private recoveryEndpoint: RecoveryEndpoint | undefined;
  private recoveryAvailable = false;
  private warnedOffline = false;
  private ready: Promise<void>;
  private initial: { resolve(): void; reject(error: unknown): void } | undefined;
  private readonly directory: string;
  private readonly subscriptions: vscode.Disposable[];
  private disposed = false;

  constructor(context: vscode.ExtensionContext, private readonly connection: Connection, private readonly currentTree: () => MetadataTree | undefined,
    private readonly application: () => string | undefined, private readonly changed: (entry: TreeEntry) => void,
    private readonly log: (value: string) => void) {
    this.directory = join(context.globalStorageUri.fsPath, "query-drafts-v1");
    this.ready = new Promise<void>((resolve, reject) => { this.initial = { resolve, reject }; });
    void this.ready.catch(() => {});
    this.subscriptions = [vscode.workspace.registerFileSystemProvider(QUERY_SCHEME, this, { isCaseSensitive: true }),
      vscode.workspace.onDidChangeTextDocument(event => {
        const session = this.session(event.document.uri);
        if (session && !this.isOwnerSnapshot(event.document.uri) && !this.disposed) {
          session.record = { ...session.record, draft: canonical(event.document.getText()) };
          this.persist(session);
          this.languageEvents.fire(event.document.uri);
        }
      }), vscode.workspace.onDidOpenTextDocument(document => {
        if (document.uri.scheme === QUERY_SCHEME) void this.restore(document).catch(error => this.failure(error));
      }), vscode.workspace.onDidCloseTextDocument(document => {
        this.closeView(document.uri);
      }), vscode.window.tabGroups.onDidChangeTabs(event => {
        for (const tab of event.closed) if (tab.input instanceof vscode.TabInputText) this.closeView(tab.input.uri);
      }), vscode.window.onDidChangeActiveTextEditor(() => this.updateContext()), connection.onRecovery(endpoint => this.connected(endpoint)), connection.beforeStop(async () => {
        try {
          await Promise.allSettled([...this.sessions.values()].map(session => session.saving));
          await this.recovery?.settled();
          await Promise.allSettled([...this.sessions.values()].map(session => this.closeSource(session)));
        }
        catch (error) { this.failure(error); }
      })];
    if (connection.recovery) this.connected(connection.recovery);
  }

  /** XML discovery is lazy, uses the current editor buffer, and releases every transient backend document. */
  async discover(tree: MetadataTree, entry: TreeEntry): Promise<QueryHeader[]> {
    if (!tree.connection.recovery?.sessions) return [];
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
        if (existing.pending || existing.source?.header.applyPending) {
          await this.focus(existing);
          throw new ExplorerError("requestFailed", "query_failed", { reason: "pending_apply" });
        }
        if (existing.record.draft !== existing.record.base) await this.focus(existing);
        const tabs = vscode.window.tabGroups.all.flatMap(group => group.tabs).filter(tab => tab.input instanceof vscode.TabInputText
          && tab.input.uri.toString() === this.uri(existing.record).toString());
        if (tabs.length && !await vscode.window.tabGroups.close(tabs)) return;
        this.sessions.delete(existing.record.id);
        await this.closeSource(existing);
        await this.requiredRecovery().remove(existing.record.id);
        this.removals.delete(existing.record.id);
      }
      const endpoint = this.recoveryEndpoint;
      const source = await this.withDocument(tree, owner, document => this.client(tree, entry.project).open(document, randomUUID(), identity, owner.userReadOnly));
      if (!endpoint || this.disposed || tree !== this.currentTree() || endpoint !== this.recoveryEndpoint) {
        await source.close().catch(() => {});
        throw new ExplorerError("obsolete");
      }
      const session: Session = { resumed: source.header.resumed, mtime: Date.now(), record: source.record, source, endpoint };
      this.sessions.set(session.record.id, session);
      await this.focus(session);
    });
  }

  /** The native cursor selects a literal through ESKA; clean SDBL and its protected owner share the backend session. */
  async showBsl(editor = vscode.window.activeTextEditor): Promise<void> {
    await this.ready;
    const tree = this.currentTree();
    if (!tree || !editor || !this.recoveryEndpoint?.sessions?.capabilities.bslEditing) throw new ExplorerError("incompatible", "query_failed", { reason: "bsl_sessions_unavailable" });
    const uri = ProtectedSources.sourceUri(editor.document.uri);
    if (uri.scheme !== "file") throw new ExplorerError("sourceMissing");
    const position = editor.selection.active;
    const document = await vscode.workspace.openTextDocument(uri);
    const version = document.version;
    if (editor.document.uri.scheme !== "file" && editor.document.getText() !== document.getText()) throw new ExplorerError("sourceChanged");
    const owner = await bslQueryOwner(tree, document);
    await this.serial(owner.entry.key, async () => {
      const existing = [...this.sessions.values()].find(session => session.record.projectKey === owner.entry.project.key
        && nodeKey(session.record.node) === nodeKey(owner.entry.node.id)
        && isDeepStrictEqual(session.record.source, owner.source));
      if (existing) { await this.focus(existing); return; }
      if (document.isClosed || document.version !== version) throw new ExplorerError("sourceChanged");
      const endpoint = this.recoveryEndpoint;
      const source = await this.withDocument(tree, owner, async retained => {
        const query = await retained.read({ at: { line: position.line, character: position.character } });
        return this.client(tree, owner.entry.project).open(retained, randomUUID(), query.identity, owner.userReadOnly);
      });
      if (!endpoint || tree !== this.currentTree() || endpoint !== this.recoveryEndpoint || this.disposed) {
        await source.close().catch(() => {}); throw new ExplorerError("obsolete");
      }
      const session: Session = { record: source.record, source, endpoint, resumed: source.header.resumed, mtime: Date.now() };
      this.sessions.set(session.record.id, session);
      try {
        await vscode.window.showTextDocument(ProtectedSources.protectedUri(uri), { preview: false, selection: editor.selection });
        await this.focus(session);
      } catch (error) {
        session.resumed = false;
        await this.closeSource(session).catch(() => {});
        throw error;
      }
    });
  }

  /** BSL application is explicit; native Save and autosave only checkpoint the independent draft. */
  async apply(uri = vscode.window.activeTextEditor?.document.uri): Promise<void> {
    await this.ready;
    const session = uri && this.session(uri);
    if (!session || session.record.identity.kind !== "bslLiteral" || this.isOwnerSnapshot(uri!)) return;
    if (!session.resumed) throw new ExplorerError("requestFailed", "query_failed", { reason: "resume_required" });
    if (session.saving) await session.saving;
    const saving = this.save(session, session.record.draft);
    session.saving = saving;
    try { await saving; }
    catch (error) {
      session.resumed = false;
      await this.closeSource(session).catch(() => {});
      throw error;
    } finally { if (session.saving === saving) delete session.saving; this.languageEvents.fire(this.uri(session.record)); }
    // Input arriving during the receipt remains a new draft on the acknowledged owner.
    if (session.record.draft === session.record.base) await this.finishBsl(session, false);
  }

  /** Explicit cancellation drops this draft without editing or saving its native owner. */
  async cancel(uri = vscode.window.activeTextEditor?.document.uri): Promise<void> {
    await this.ready;
    const session = uri && this.session(uri);
    if (session?.record.identity.kind === "bslLiteral" && !this.isOwnerSnapshot(uri!)) await this.finishBsl(session, false);
  }

  /** Explicit resumption prevents autosave from applying a recovered draft before owner/context verification. */
  async resume(uri = vscode.window.activeTextEditor?.document.uri): Promise<void> {
    await this.ready;
    const session = uri && this.session(uri);
    if (!session) return;
    if (session.saving) await session.saving.catch(() => {});
    session.resumed = false;
    const tree = this.currentTree();
    if (!tree) throw new ExplorerError("obsolete");
    try {
      const source = await this.source(session, tree);
      const owner = await this.owner(session, tree);
      await source.resume(this.ownerFacts(owner.document, owner.userReadOnly));
      this.accept(session, source);
      await this.focus(session);
    } catch (error) {
      session.resumed = false;
      await this.closeSource(session).catch(() => {});
      throw error;
    }
  }

  /** A connection replacement cannot reuse an earlier owner's authority. Draft text remains available. */
  stale(): void { for (const session of this.sessions.values()) session.resumed = false; this.languageEvents.fire(undefined); }

  /** Native language providers present the backend's actual support and explicit resume state. */
  languageState(document: vscode.TextDocument): "bsl" | "basic" | "backend" | "paused" | undefined {
    const session = this.session(document.uri);
    if (!session || this.isOwnerSnapshot(document.uri)) return undefined;
    if (session.record.identity.kind !== "bslLiteral") return "basic";
    if (this.recoveryAvailable && !this.recoveryEndpoint?.sessions?.capabilities.projections) return "backend";
    return !this.disposed && this.recoveryAvailable
      && session.resumed && !session.pending && !session.saving && !!session.source ? "bsl" : "paused";
  }

  /** Only ESKA constructs the immutable language input and checks its current native owner facts. */
  async languageProjection(document: vscode.TextDocument): Promise<{ owner: vscode.TextDocument; projection: QueryLanguageProjection }> {
    await this.ready;
    const tree = this.currentTree(), session = this.session(document.uri), version = document.version;
    if (!tree || !session || document.isClosed || this.languageState(document) !== "bsl") throw new ExplorerError("obsolete");
    const draft = canonical(document.getText());
    await this.requiredRecovery().saveDraft(session.record.id, draft);
    const owner = await this.owner(session, tree), facts = this.ownerFacts(owner.document, owner.userReadOnly);
    const source = session.source;
    if (!source || this.languageState(document) !== "bsl") throw new ExplorerError("obsolete");
    const projection = await source.projection(facts);
    if (this.disposed || tree !== this.currentTree() || session.source !== source || this.languageState(document) !== "bsl"
      || document.isClosed || document.version !== version || canonical(document.getText()) !== projection.draft
      || owner.document.isClosed || String(owner.document.version) !== facts.version || querySnapshot(owner.document.getText()) !== facts.snapshot) {
      await projection.close().catch(() => {}); throw new ExplorerError("obsolete");
    }
    return { owner: owner.document, projection };
  }

  /** Expose the retained dirty-owner snapshot for review without making it a project source. */
  async compare(uri = vscode.window.activeTextEditor?.document.uri): Promise<void> {
    await this.ready;
    const session = uri && this.session(uri);
    if (!session) return;
    const snapshot = this.ownerUri(session.record);
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
    return Buffer.from(this.isOwnerSnapshot(uri) ? session.record.ownerText
      : session.record.identity.kind === "bslLiteral" ? session.record.draft : session.record.base);
  }

  /** Provider metadata never delegates a writable native source URI. */
  async stat(uri: vscode.Uri): Promise<vscode.FileStat> {
    await this.ready;
    const session = this.required(uri);
    return { type: vscode.FileType.File, ctime: 1, mtime: this.isOwnerSnapshot(uri) ? session.ownerMtime ?? session.mtime : session.mtime,
      size: Buffer.byteLength(this.isOwnerSnapshot(uri) ? session.record.ownerText
        : session.record.identity.kind === "bslLiteral" ? session.record.draft : session.record.base),
      ...(!(session.source?.header.draftWritable ?? session.record.writable) || this.isOwnerSnapshot(uri) ? { permissions: vscode.FilePermission.Readonly } : {}) };
  }

  /** XML Save applies a checked plan; BSL Save acknowledges only its private checkpoint. */
  async writeFile(uri: vscode.Uri, content: Uint8Array): Promise<void> {
    await this.ready;
    const session = this.required(uri);
    if (this.isOwnerSnapshot(uri) || !(session.source?.header.draftWritable ?? session.record.writable)) throw vscode.FileSystemError.NoPermissions(this.text("queryReadonly"));
    if (!session.resumed && session.record.identity.kind !== "bslLiteral") throw vscode.FileSystemError.Unavailable(this.text("queryResumeRequired"));
    const draft = canonical(new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(content));
    if (session.saving) await session.saving;
    const saving = session.record.identity.kind === "bslLiteral" ? this.checkpoint(session, draft) : this.save(session, draft);
    session.saving = saving;
    try { await saving; }
    catch (error) {
      session.resumed = false;
      await this.closeSource(session).catch(() => {});
      this.failure(error);
      throw vscode.FileSystemError.Unavailable(this.text("querySaveFailed"));
    } finally { if (session.saving === saving) delete session.saving; this.languageEvents.fire(this.uri(session.record)); }
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
    this.initial?.reject(new ExplorerError("obsolete"));
    this.initial = undefined;
    try {
      if (!this.recovery) return;
      await this.ready;
      await Promise.allSettled([...this.sessions.values()].map(session => session.saving));
      await this.recovery.settled();
      await Promise.allSettled([...this.sessions.values()].map(session => this.closeSource(session)));
      if (this.recoveryAvailable) await this.recovery.close();
    } finally {
      for (const subscription of this.subscriptions) subscription.dispose();
      this.events.dispose();
      this.languageEvents.dispose();
    }
  }

  /** Recover private records without resolving or applying their owners. */
  private async load(recovery: QueryRecovery): Promise<void> {
    await recovery.records();
    if (this.recovery !== recovery || !this.recoveryAvailable || this.disposed) throw new ExplorerError("obsolete");
    for (const id of this.removals) {
      if (this.requiredRecovery() !== recovery) throw new ExplorerError("obsolete");
      try { await recovery.remove(id); this.removals.delete(id); }
      catch (error) { this.failure(error); }
    }
    for (const record of await recovery.records()) {
      if (this.requiredRecovery() !== recovery) throw new ExplorerError("obsolete");
      if (this.removals.has(record.id)) continue;
      const session = this.sessions.get(record.id);
      if (!session) this.sessions.set(record.id, { record, resumed: false, mtime: Date.now(), pending: recovery.hasPrepared(record.id) });
      else if (!isDeepStrictEqual(session.record, record)) {
        try {
          await recovery.saveDraft(record.id, session.record.draft);
          session.record = recovery.record(record.id);
          session.pending = recovery.hasPrepared(record.id);
        }
        catch (error) { this.failure(error); }
      }
    }
  }

  /** An initialized endpoint is enough for recovery; a valid metadata tree is needed only for applying. */
  private connected(endpoint: RecoveryEndpoint | undefined): void {
    if (this.disposed) return;
    this.recoveryAvailable = endpoint !== undefined;
    if (!endpoint) {
      this.stale();
      if (["error", "ready", "disconnected", "stopping"].includes(this.connection.state.kind)) {
        this.initial?.reject(new ExplorerError("incompatible"));
        this.initial = undefined;
      }
      return;
    }
    if (endpoint === this.recoveryEndpoint) return;
    this.warnedOffline = false;
    this.recoveryEndpoint = endpoint;
    const recovery = new QueryRecovery(endpoint, this.directory, () => {
      void vscode.window.showWarningMessage(this.text("queryRecoveryDamaged"));
    }, this.recovery?.revisions());
    this.recovery = recovery;
    this.ready = this.load(recovery);
    const initial = this.initial;
    this.initial = undefined;
    void this.ready.then(() => initial?.resolve(), error => {
      initial?.reject(error);
      if (this.recovery === recovery && this.recoveryAvailable) this.failure(error);
    });
  }

  /** Disconnected input remains in its native model and is reconciled against disk revisions on reconnect. */
  private persist(session: Session): void {
    if (this.recoveryAvailable) void this.recovery?.saveDraft(session.record.id, session.record.draft).catch(error => this.failure(error));
    else if (!this.warnedOffline && !this.disposed) {
      this.warnedOffline = true;
      void vscode.window.showWarningMessage(this.text("queryRecoveryOffline"));
    }
  }

  /** Source editing cannot fall back to an adapter-owned file store or an earlier backend process. */
  private requiredRecovery(): QueryRecovery {
    if (!this.recoveryAvailable || !this.recovery || this.connection.recovery !== this.recoveryEndpoint) throw new ExplorerError("incompatible");
    return this.recovery;
  }

  /** A cached TextDocument may outlive its last tab; only a live view keeps a clean session active. */
  private closeView(uri: vscode.Uri): void {
    if (this.disposed || this.isOwnerSnapshot(uri)) return;
    const session = this.session(uri);
    if (!session || session.ending || vscode.window.tabGroups.all.some(group => group.tabs.some(tab => tab.input instanceof vscode.TabInputText
      && tab.input.uri.toString() === uri.toString()))) return;
    if (session.saving) {
      void session.saving.then(() => this.closeView(uri), () => this.closeView(uri));
      return;
    }
    if (session.record.identity.kind === "bslLiteral" && session.record.draft !== session.record.base) {
      if (!session.closing) {
        const closing = this.closeBsl(session);
        session.closing = closing;
        void closing.catch(error => this.failure(error)).finally(() => { if (session.closing === closing) delete session.closing; });
      }
      return;
    }
    if (session.record.draft !== session.record.base || session.pending || session.source?.header.applyPending) {
      session.resumed = false;
      this.persist(session);
      void this.closeSource(session).catch(error => this.failure(error));
      return;
    }
    this.sessions.delete(session.record.id);
    this.events.fire([{ type: vscode.FileChangeType.Deleted, uri }]);
    this.removals.add(session.record.id);
    if (this.recoveryAvailable) void this.closeSource(session).then(() => this.recovery?.remove(session.record.id)).then(
      () => this.removals.delete(session.record.id), error => this.failure(error));
  }

  /** A closed dirty BSL view retains its checkpoint while the user chooses Apply, Keep, Discard or Cancel. */
  private async closeBsl(session: Session): Promise<void> {
    await this.requiredRecovery().settled();
    const choice = await this.closeDecision();
    if (choice === "keep") { session.resumed = false; await this.closeSource(session); return; }
    if (choice === "discard") { await this.finishBsl(session, false); return; }
    await this.focus(session);
    if (choice === "apply") {
      if (!session.resumed) await this.resume(this.uri(session.record));
      await this.apply(this.uri(session.record));
    }
  }

  /** Dialog labels are localized presentation; the close lifecycle uses stable decisions. */
  private async closeDecision(): Promise<"apply" | "keep" | "discard" | undefined> {
    const apply = this.text("queryApply"), keep = this.text("queryKeep"), discard = this.text("queryDiscard");
    const choice = await vscode.window.showWarningMessage(this.text("queryCloseChanged"), { modal: true }, apply, keep, discard);
    return choice === apply ? "apply" : choice === keep ? "keep" : choice === discard ? "discard" : undefined;
  }

  /** Close only this draft's native tabs, then release its backend lease and optionally remove its checkpoint. */
  private async finishBsl(session: Session, keep: boolean): Promise<void> {
    if (session.saving) await session.saving;
    const uri = this.uri(session.record);
    const document = vscode.workspace.textDocuments.find(document => document.uri.toString() === uri.toString());
    if (document && nativeDirty(document) && !await document.save()) throw new ExplorerError("sourceChanged");
    session.ending = true;
    try {
      const tabs = vscode.window.tabGroups.all.flatMap(group => group.tabs).filter(tab => tab.input instanceof vscode.TabInputText
        && tab.input.uri.toString() === uri.toString());
      if (tabs.length && !await vscode.window.tabGroups.close(tabs)) return;
      session.resumed = false;
      await this.closeSource(session);
      if (!keep) {
        await this.requiredRecovery().remove(session.record.id, true);
        this.sessions.delete(session.record.id);
        this.events.fire([{ type: vscode.FileChangeType.Deleted, uri }]);
      }
    } finally { delete session.ending; }
  }

  /** Save acknowledges only private storage; even autosave cannot prepare or apply a BSL source edit. */
  private async checkpoint(session: Session, draft: string): Promise<void> {
    if (session.record.draft !== draft) throw new ExplorerError("sourceChanged");
    await this.requiredRecovery().saveDraft(session.record.id, draft);
    session.mtime++;
  }

  /** Hot-exit text wins over an older private record; otherwise restore through a real dirty editor edit. */
  private async restore(document: vscode.TextDocument): Promise<void> {
    await this.serial(document.uri.toString(), () => this.restoreOnce(document));
  }

  /** Open and focus callbacks must not submit the same restoration edit concurrently. */
  private async restoreOnce(document: vscode.TextDocument): Promise<void> {
    await this.ready;
    const session = this.session(document.uri);
    if (this.disposed || !session || this.isOwnerSnapshot(document.uri) || document.isClosed) return;
    const text = canonical(document.getText());
    // BSL checkpoints already contain the saved view. Its close decision uses semantic changes, not a forced native dirty bit.
    if (session.record.identity.kind === "bslLiteral" && text === session.record.draft) return;
    if (nativeDirty(document) && text !== session.record.base && text !== session.record.draft) {
      session.record = { ...session.record, draft: text };
      this.persist(session);
      return;
    }
    if ((text !== session.record.base && text !== session.record.draft) || session.record.draft === session.record.base
      || (text === session.record.draft && nativeDirty(document))) return;
    const editor = vscode.window.visibleTextEditors.find(editor => editor.document === document);
    if (text === session.record.draft && editor) {
      const range = new vscode.Range(document.positionAt(0), document.positionAt(document.getText().length));
      if (!await editor.edit(edit => edit.replace(range, session.record.draft))) throw new ExplorerError("sourceChanged");
      return;
    }
    const edit = new vscode.WorkspaceEdit();
    edit.replace(document.uri, new vscode.Range(document.positionAt(0), document.positionAt(document.getText().length)), session.record.draft);
    if (!await vscode.workspace.applyEdit(edit)) throw new ExplorerError("sourceChanged");
  }

  /** Native CAS, Undo/Redo and optional disk save implement a plan whose lifecycle is owned by ESKA. */
  private async save(session: Session, draft: string): Promise<void> {
    const tree = this.currentTree();
    if (!tree || this.disposed) throw new ExplorerError("obsolete");
    const selection = this.application();
    const source = await this.source(session, tree);
    const owner = await this.owner(session, tree);
    const facts = this.ownerFacts(owner.document, owner.userReadOnly);
    let attempted = false;
    try {
      if (session.record.draft !== draft) throw new ExplorerError("requestFailed", "query_failed", { reason: "stale_draft" });
      await this.requiredRecovery().saveDraft(session.record.id, draft);
      const plan = await source.prepare(facts, draft, [], owner.document.eol === vscode.EndOfLine.CRLF ? "crlf" : "lf");
      session.pending = true;
      if (this.disposed || tree !== this.currentTree() || !session.resumed || selection !== this.application()) throw new ExplorerError("obsolete");
      if (await nativeReadOnly(owner.document)) throw new ExplorerError("requestFailed", "query_failed", { reason: "user_read_only" });
      this.assertOwner(owner.document, facts);
      if (!plan.noOp) {
        const edit = new vscode.WorkspaceEdit();
        for (const replacement of plan.replacements) edit.replace(owner.document.uri,
          new vscode.Range(replacement.rangeUtf16.start.line, replacement.rangeUtf16.start.character,
            replacement.rangeUtf16.end.line, replacement.rangeUtf16.end.character), replacement.text);
        attempted = true;
        if (!await vscode.workspace.applyEdit(edit)) throw new ExplorerError("sourceChanged");
        if (querySnapshot(owner.document.getText()) !== plan.outputSnapshot) throw new ExplorerError("sourceChanged");
        if (plan.saveOwner && !await owner.document.save()) throw new ExplorerError("sourceChanged");
      }
      if (querySnapshot(owner.document.getText()) !== plan.outputSnapshot) throw new ExplorerError("sourceChanged");
      await source.applied(plan.applyToken, this.ownerFacts(owner.document, await nativeReadOnly(owner.document)));
      this.accept(session, source, true);
      const entry = owner.project.nodes.get(nodeKey(session.record.node));
      if (entry) this.changed(entry);
    } catch (error) {
      session.resumed = false;
      session.pending = source.header.applyPending;
      const token = source.header.record.prepared?.applyToken;
      if (!attempted && token) {
        try { await source.abort(token); this.accept(session, source); }
        catch { /* An unacknowledged cleanup keeps its durable intent for explicit recovery. */ }
      }
      await this.closeSource(session).catch(() => {});
      throw error;
    }
  }

  /** Only a checked backend source handle can provide the binding used for native application. */
  private async source(session: Session, tree: MetadataTree): Promise<QuerySourceSession> {
    if (session.source && session.endpoint === this.recoveryEndpoint) return session.source;
    const project = tree.projects.find(project => project.key === session.record.projectKey);
    if (!project) throw new ExplorerError("sourceChanged");
    const endpoint = this.recoveryEndpoint;
    const source = await this.client(tree, project).restore(session.record.id);
    if (!endpoint || this.disposed || tree !== this.currentTree() || endpoint !== this.recoveryEndpoint) {
      await source.close().catch(() => {});
      throw new ExplorerError("obsolete");
    }
    session.source = source;
    session.endpoint = endpoint;
    this.accept(session, source);
    return source;
  }

  /** ESKA has already resolved the source/member; the adapter opens only its native document view. */
  private async owner(session: Session, tree: MetadataTree): Promise<{ project: ProjectTree; document: vscode.TextDocument; userReadOnly: boolean }> {
    const project = tree.projects.find(project => project.key === session.record.projectKey);
    if (!project) throw new ExplorerError("sourceChanged");
    const path = await existingSource(project.info.sourcePath, session.record.source);
    const document = await vscode.workspace.openTextDocument(vscode.Uri.file(path));
    return { project, document, userReadOnly: await nativeReadOnly(document) };
  }

  /** These are exact native facts; disk, descriptor, source policy and context are checked by the core. */
  private ownerFacts(document: vscode.TextDocument, userReadOnly: boolean): QueryOwnerFacts {
    if (document.isClosed) throw new ExplorerError("sourceChanged");
    return { version: String(document.version), snapshot: querySnapshot(document.getText()), isDirty: nativeDirty(document),
      userReadOnly, application: this.application() ?? null };
  }

  /** A text plan can touch only the native version that supplied its preflight facts. */
  private assertOwner(document: vscode.TextDocument, facts: QueryOwnerFacts): void {
    if (configuredReadOnly(document) || document.isClosed || String(document.version) !== facts.version || querySnapshot(document.getText()) !== facts.snapshot) {
      throw new ExplorerError("sourceChanged");
    }
  }

  /** Cached presentation follows acknowledged backend state and the queue's rebased native draft. */
  private accept(session: Session, source: QuerySourceSession, saved = false): void {
    if (session.endpoint !== this.recoveryEndpoint || session.source !== source) throw new ExplorerError("obsolete");
    const oldOwner = session.record.ownerText;
    session.record = source.record;
    session.resumed = source.header.resumed;
    session.pending = source.header.applyPending;
    this.languageEvents.fire(this.uri(session.record));
    if (saved) session.mtime++;
    if (oldOwner !== session.record.ownerText) {
      session.ownerMtime = (session.ownerMtime ?? session.mtime) + 1;
      this.events.fire([{ type: vscode.FileChangeType.Changed, uri: this.ownerUri(session.record) }]);
    }
  }

  /** A client is bound to the initialized process and one metadata member, not a VS Code URI. */
  private client(tree: MetadataTree, project: ProjectTree): QuerySessions {
    const state = tree.connection.state;
    const recovery = this.requiredRecovery();
    if (tree !== this.currentTree() || state.kind !== "ready" || !state.queryEditing || !this.recoveryEndpoint) throw new ExplorerError("incompatible");
    return new QuerySessions(this.recoveryEndpoint, recovery, () => ({ sessionId: tree.session.sessionId,
      projectId: project.info.projectId, generation: project.info.generation }), state.queryEditing);
  }

  /** Native views may close independently; releasing a handle never deletes its retained checkpoint. */
  private async closeSource(session: Session): Promise<void> {
    const source = session.source;
    delete session.source;
    delete session.endpoint;
    this.languageEvents.fire(this.uri(session.record));
    await source?.close();
  }

  /** No document handle survives discovery, save, cancellation or a thrown callback. */
  private async withDocument<T>(tree: MetadataTree, owner: QueryOwnerView, action: (document: QueryDocument) => Promise<T>): Promise<T> {
    const state = tree.connection.state;
    if (tree !== this.currentTree() || state.kind !== "ready" || !state.queryEditing) throw new ExplorerError("incompatible");
    this.requiredRecovery();
    const client = new QueryClient(tree.connection, tree.session.sessionId, owner.entry.project, state.queryEditing);
    const application = this.application();
    const document = await client.open({ node: owner.entry.node.id, source: owner.source,
      version: String(owner.document.version), text: owner.document.getText(), ...(application ? { application } : {}) });
    try {
      if (this.disposed || tree !== this.currentTree() || !this.recoveryAvailable) throw new ExplorerError("obsolete");
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
    this.updateContext();
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
  private isOwnerSnapshot(uri: vscode.Uri): boolean { return ["owner.xml", "owner.bsl"].includes(uri.path.split("/")[2] ?? ""); }

  /** The snapshot keeps the owner language while its UUID remains the only session identity. */
  private ownerUri(record: QueryDraftRecord): vscode.Uri {
    return this.uri(record).with({ path: `/${record.id}/owner.${record.identity.kind === "bslLiteral" ? "bsl" : "xml"}` });
  }

  /** Only exact session filenames and original snapshots are readable; arbitrary URI paths are refused. */
  private session(uri: vscode.Uri): Session | undefined {
    if (uri.scheme !== QUERY_SCHEME) return undefined;
    const id = uri.path.split("/")[1];
    const session = id ? this.sessions.get(id) : undefined;
    return session && (this.uri(session.record).toString() === uri.toString()
      || this.ownerUri(session.record).toString() === uri.toString()) ? session : undefined;
  }

  /** Missing private records cannot fall back to any file on disk. */
  private required(uri: vscode.Uri): Session {
    const session = this.session(uri);
    if (!session) throw vscode.FileSystemError.FileNotFound(uri);
    return session;
  }

  /** Toolbar visibility describes only the active view; ESKA still decides whether Apply is allowed. */
  private updateContext(): void {
    const uri = vscode.window.activeTextEditor?.document.uri;
    const session = uri && this.session(uri);
    void vscode.commands.executeCommand("setContext", "eska.queryBsl", !!session && !this.isOwnerSnapshot(uri!)
      && session.record.identity.kind === "bslLiteral");
  }

  /** Technical reasons stay in diagnostics; presentation always has both supported locales. */
  private failure(error: unknown): void {
    this.log(`query_error code=${error instanceof ExplorerError ? error.code : "io"} kind=${error instanceof ExplorerError ? error.domain ?? "none" : "none"}`);
    const reason = error instanceof ExplorerError ? error.details?.reason : undefined;
    const key = reason === "bsl_sessions_unavailable" ? "queryBslUnavailable"
      : error instanceof ExplorerError && error.code === "incompatible" ? "queryUnavailable"
      : ["unsupported_expression", "invalid_literal", "not_found"].includes(String(reason)) ? "queryUnsupported"
      : ["read_only", "user_read_only"].includes(String(reason)) ? "queryReadonly" : reason === "comments_require_decision" ? "queryComments" : "querySaveFailed";
    if (!this.disposed) void vscode.window.showWarningMessage(this.text(key));
  }

  /** Localize only UI, never persisted identities or protocol fields. */
  private text(key: MessageKey): string { return message(vscode.env.language, key); }
}

/** SDBL editor line endings are logical LF; source physical lines are chosen separately in query/plan. */
function canonical(text: string): string { return text.replaceAll("\r\n", "\n").replaceAll("\r", "\n"); }
