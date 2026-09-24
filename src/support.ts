import * as vscode from 'vscode';
import { join, relative, isAbsolute } from 'node:path';
import { createHash } from 'node:crypto';
import { isRecord, isWirePath } from './protocol.js';
import { nativePath } from './source.js';
import type { MetadataTree, ProjectTree, TreeEntry } from './tree.js';
import { reconcileRules, readonlyPattern, readonlyPatterns } from './support-settings.js';
import { ProtectedSources } from './protected-source.js';

type State = 'locked' | 'editableWithSupport' | 'unrestricted' | 'unknown';
interface ObjectPolicy { objectId: string; uuid: string; state: State; reason: string }
interface FilePolicy { path: string; objects: string[]; readOnly: boolean; mixed: boolean; unknown: boolean }
interface Snapshot { generation: string; eventSequence: string; objects: Map<string, ObjectPolicy>; files: FilePolicy[]; diagnostics: string[] }

/** Localize support semantics without confusing an object policy with a mixed physical XML. */
export function supportText(key: string): string {
  const ru = vscode.env.language.toLowerCase().startsWith('ru');
  const texts: Record<string, [string, string]> = {
    configurationLocked: ['Изменение конфигурации запрещено правилами поддержки', 'Configuration changes are prohibited by support rules'],
    vendorLocked: ['Объект поставщика не редактируется', 'Vendor object changes are not allowed'],
    editableWithSupport: ['Редактируется с сохранением поддержки', 'Editable with support retained'],
    ownObject: ['Собственный объект: ограничений поддержки нет', 'Own object: no vendor support restrictions'],
    supportRemoved: ['Объект снят с поддержки', 'Vendor support removed for this object'],
    unknown: ['Состояние поддержки неизвестно', 'Support state is unknown'],
    pending: ['Сведения о поддержке обновляются; защита ещё не подтверждена.', 'Support information is updating; protection is not yet confirmed.'],
    mixed: ['Файл содержит объекты, изменение которых запрещено правилами поддержки.', 'The file contains objects whose support rules prohibit changes.'],
    compatibility: ['Backend не предоставляет сведения о поддержке; защита eska недоступна.', 'Backend does not provide support policy; ESKA protection is unavailable.'],
    dirty: ['Правила поддержки запрещают изменение открытого файла. Несохранённый текст сохранён в редакторе.', 'Support rules prohibit changes to this open file. Unsaved text is preserved in the editor.'],
  };
  return texts[key]?.[ru ? 0 : 1] ?? texts.unknown![ru ? 0 : 1];
}

/** Own exact-file settings and native decorations independently of which tree opened a file. */
export class SupportController implements vscode.FileDecorationProvider {
  private tree: MetadataTree | undefined;
  private additional: MetadataTree[] = [];
  private pendingFolders: string[] = [];
  private epoch = 0;
  private timer: NodeJS.Timeout | undefined;
  private fileTimer: NodeJS.Timeout | undefined;
  private serial: Promise<void> = Promise.resolve();
  private readonly snapshots = new Map<ProjectTree, Snapshot>();
  private readonly changed = new vscode.EventEmitter<vscode.Uri[] | undefined>();
  readonly onDidChangeFileDecorations = this.changed.event;
  private readonly subscription: vscode.Disposable;
  private readonly settingsSubscription: vscode.Disposable;
  private writing: { baseline: Record<string, boolean>; expected: Record<string, boolean>; edits: Map<string, boolean | undefined> } | undefined;
  private stopped = false;
  private available = false;
  private targeted = false;
  private readonly requestedFiles = new Set<string>();
  private readonly requestedEntries = new Set<string>();
  private readonly documentSubscription: vscode.Disposable;
  private readonly editorSubscription: vscode.Disposable;
  private readonly protecting = new Set<vscode.TextEditor>();
  loading = false;
  failed = false;
  private clearRestrictions = false;
  private requested: string | undefined;
  private readonly mixedObjects = new Map<ProjectTree, Set<string>>();
  private readonly fileIndex = new Map<string, { file: FilePolicy; snapshot: Snapshot }>();

  constructor(private readonly context: vscode.ExtensionContext, private readonly repaint: () => void, private readonly log: (text: string) => void) {
    this.subscription = vscode.window.registerFileDecorationProvider(this);
    this.documentSubscription = vscode.workspace.onDidOpenTextDocument(document => {
      if (document.uri.scheme === 'file') this.queueFile(document.uri.fsPath);
    });
    this.editorSubscription = vscode.window.onDidChangeVisibleTextEditors(editors => {
      for (const editor of editors) void this.protectEditor(editor);
    });
    this.settingsSubscription = vscode.workspace.onDidChangeConfiguration(event => {
      if (!event.affectsConfiguration('files.readonlyInclude') || !this.writing) return;
      const current = this.readRules();
      const same = (left: Record<string, boolean>, right: Record<string, boolean>): boolean =>
        JSON.stringify(Object.entries(left).sort()) === JSON.stringify(Object.entries(right).sort());
      if (same(current, this.writing.expected)) return;
      for (const key of new Set([...Object.keys(this.writing.baseline), ...Object.keys(current)])) {
        if (current[key] !== this.writing.baseline[key]) this.writing.edits.set(key, current[key]);
      }
    });
  }

  /** One window-wide switch governs both navigation and additional workspace folders. */
  get enabled(): boolean { return vscode.workspace.getConfiguration('eska.explorer').get<boolean>('supportPolicy', true); }

  /** A session change invalidates every queued response before any setting is written. */
  setTree(tree: MetadataTree | undefined, available: boolean, clearRestrictions = false, targeted = false): void {
    this.tree = tree; this.available = available; this.targeted = targeted; this.epoch++; this.requested = undefined;
    this.clearRestrictions = clearRestrictions;
    this.loading = this.enabled && !!tree && available && !this.targeted;
    this.failed = false;
    this.snapshots.clear();
    this.invalidate();
  }

  /** Additional native workspace folders use independent backend sessions. */
  setAdditionalTrees(trees: MetadataTree[], pendingFolders: string[] = []): void {
    this.additional = trees;
    this.pendingFolders = pendingFolders;
    this.requested = undefined;
    this.invalidate();
  }

  /** Coalesce file events; painting and opening never trigger a project scan. */
  invalidate(): void {
    if (this.stopped) return;
    const key = JSON.stringify([this.enabled, this.available, this.pendingFolders, [this.tree, ...this.additional].filter(Boolean).map(tree => [tree?.session.sessionId, tree?.projects.map(project => [project.supportGeneration ?? project.info.generation, project.supportEventSequence ?? project.info.eventSequence])])]);
    if (key === this.requested) {
      // A backend-confirmed BSL-only edit advances metadata tokens without changing support.
      for (const [project, snapshot] of this.snapshots) {
        snapshot.generation = project.info.generation;
        snapshot.eventSequence = project.info.eventSequence;
      }
      return;
    }
    this.requested = key;
    const epoch = ++this.epoch;
    clearTimeout(this.fileTimer);
    this.requestedEntries.clear();
    this.loading = this.enabled && !!this.tree && this.available && !this.targeted;
    this.failed = false;
    if (!this.enabled) {
      this.snapshots.clear(); this.fileIndex.clear(); this.mixedObjects.clear();
      this.changed.fire(undefined);
    }
    this.repaint();
    clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.serial = this.serial.then(() => this.refresh(epoch)).catch(error => {
        if (epoch !== this.epoch) return;
        this.requested = undefined; this.loading = false; this.failed = true;
        this.log(`support_update_failed ${String(error)}`); this.repaint();
      });
    }, 100);
  }

  /** Resolve a tree object's own status, leaving virtual groups undecorated. */
  object(entry: TreeEntry): ObjectPolicy | undefined {
    if (!this.enabled || entry.node.id.kind === 'collection') return undefined;
    const id = entry.node.id.kind === 'object' ? entry.node.id.objectId : entry.node.id.owner;
    const snapshot = this.snapshots.get(entry.project);
    const current = snapshot?.generation === entry.project.info.generation && snapshot?.eventSequence === entry.project.info.eventSequence;
    if (!current || !snapshot.objects.has(id)) this.queueEntry(entry);
    return (current ? snapshot.objects.get(id) : undefined) ?? { objectId: id, uuid: '', state: 'unknown', reason: this.available ? 'unknown' : 'compatibility' };
  }

  /** Include read failures and shared-XML constraints without changing the object's policy. */
  explanation(entry: TreeEntry): string {
    const policy = this.object(entry);
    if (!policy) return '';
    const details = [supportText(policy.reason)];
    const snapshot = this.snapshots.get(entry.project);
    if (policy.state === 'unknown' && snapshot?.diagnostics.length) details.push(snapshot.diagnostics.join('; '));
    if (entry.node.id.kind === 'object' && this.mixedObjects.get(entry.project)?.has(policy.objectId)) details.push(supportText('mixed'));
    return details.join('\n');
  }

  /** Select bundled Material artwork from confirmed policy, never infer removal from unrestricted alone. */
  icon(entry: TreeEntry): 'lock' | 'lock_open_right' | 'no_encryption' | undefined {
    const policy = this.object(entry);
    if (policy?.state === 'locked') return 'lock';
    if (policy?.state === 'editableWithSupport') return 'lock_open_right';
    if (policy?.state === 'unrestricted' && policy.reason === 'supportRemoved') return 'no_encryption';
    return undefined;
  }

  /** A single short badge is supported by the public API in all native tree themes. */
  decoration(entry: TreeEntry): vscode.FileDecoration | undefined {
    const policy = this.object(entry);
    if (!policy || policy.state === 'unrestricted' || policy.state === 'unknown') return undefined;
    return new vscode.FileDecoration(policy.state === 'locked' ? '🔒' : 'S', this.explanation(entry));
  }

  /** Standard Explorer uses real file URIs and can request explanations before our tree is visible. */
  provideFileDecoration(uri: vscode.Uri): vscode.FileDecoration | undefined {
    if (!this.enabled || uri.scheme !== 'file') return undefined;
    const current = this.fileIndex.get(uri.toString());
    if (!current) this.queueFile(uri.fsPath);
    if (current) {
      const { file, snapshot } = current;
      const project = [...this.snapshots].find(([, value]) => value === snapshot)?.[0];
      if (!project || project.info.generation !== snapshot.generation || project.info.eventSequence !== snapshot.eventSequence) return undefined;
      if (file.unknown) return undefined;
      if (file.readOnly) return new vscode.FileDecoration('🔒', supportText(file.mixed ? 'mixed' : 'vendorLocked'));
      if (file.objects.some(id => snapshot.objects.get(id)?.state === 'editableWithSupport')) return new vscode.FileDecoration('S', supportText('editableWithSupport'));
    }
    return undefined;
  }

  /** ESKA navigation uses an immutable readonly provider for confirmed locked sources. */
  openUri(path: string): vscode.Uri {
    const source = vscode.Uri.file(path);
    const policy = this.enabled ? this.fileIndex.get(source.toString())?.file : undefined;
    return policy?.readOnly ? ProtectedSources.protectedUri(source) : source;
  }

  /** Every open checks current dependency bytes; an unavailable result stays readable but immutable. */
  async resolveUri(path: string): Promise<vscode.Uri> {
    if (!this.targeted || !this.enabled || !this.locate(path)) return this.openUri(path);
    const epoch = this.epoch;
    let checked = false;
    this.serial = this.serial.then(async () => { await this.queryFiles([path], epoch); checked = true; }).catch(error => this.log(`support_file_failed ${String(error)}`));
    await this.serial;
    const policy = this.fileIndex.get(vscode.Uri.file(path).toString())?.file;
    return !checked || epoch !== this.epoch || !policy || policy.readOnly || policy.unknown
      ? ProtectedSources.protectedUri(vscode.Uri.file(path)) : vscode.Uri.file(path);
  }

  /** Native file opens use the same immutable provider; dirty buffers are never discarded or replaced. */
  private async protectEditor(editor: vscode.TextEditor): Promise<void> {
    if (!this.targeted || !this.enabled || this.stopped || editor.document.uri.scheme !== 'file'
      || (!this.locate(editor.document.uri.fsPath) && !this.fileIndex.get(editor.document.uri.toString())?.file.readOnly)
      || this.protecting.has(editor)) return;
    this.protecting.add(editor);
    try {
      const uri = await this.resolveUri(editor.document.uri.fsPath);
      if (this.stopped || !this.enabled || uri.scheme === 'file' || editor.document.isDirty
        || !vscode.window.visibleTextEditors.includes(editor)) return;
      const document = await vscode.workspace.openTextDocument(uri);
      if (editor.document.isDirty || !vscode.window.visibleTextEditors.includes(editor)) return;
      const tabs = vscode.window.tabGroups.all.flatMap(group => group.tabs).filter(tab =>
        tab.input instanceof vscode.TabInputText && tab.input.uri.toString() === editor.document.uri.toString() && !tab.isDirty);
      await vscode.window.showTextDocument(document, { ...(editor.viewColumn === undefined ? {} : { viewColumn: editor.viewColumn }),
        preserveFocus: vscode.window.activeTextEditor !== editor, preview: true, selection: editor.selection });
      for (const tab of tabs) if (!tab.isDirty) await vscode.window.tabGroups.close(tab, true);
    } catch (error) { this.log(`support_editor_failed ${String(error)}`); }
    finally { this.protecting.delete(editor); }
  }

  /** Resolve source membership through native path boundaries, including additional workspace folders. */
  private locate(path: string): { tree: MetadataTree; project: ProjectTree; relative: string } | undefined {
    for (const tree of [this.tree, ...this.additional]) if (tree) for (const project of tree.projects) {
      const local = relative(nativePath(project.info.sourcePath), path);
      if (local && !isAbsolute(local) && local !== '..' && !local.startsWith('..' + (process.platform === 'win32' ? '\\' : '/'))) return { tree, project, relative: local };
    }
    return undefined;
  }

  /** Coalesce only files requested by a visible editor or native file decoration. */
  private queueFile(path: string): void {
    if (!this.targeted || !this.enabled || this.stopped || !this.locate(path) || this.requestedFiles.has(path)) return;
    this.requestedFiles.add(path);
    const epoch = this.epoch;
    clearTimeout(this.fileTimer);
    this.fileTimer = setTimeout(() => {
      const paths = [...this.requestedFiles]; this.requestedFiles.clear();
      this.serial = this.serial.then(() => this.queryFiles(paths, epoch)).catch(error => this.log(`support_file_failed ${String(error)}`));
    }, 25);
  }

  /** Resolve descriptors only for painted objects; opaque object IDs are never decoded in the client. */
  private queueEntry(entry: TreeEntry): void {
    if (!this.targeted || this.stopped || !this.enabled) return;
    const tree = [this.tree, ...this.additional].find(tree => tree?.projects.includes(entry.project));
    if (!tree) return;
    const key = JSON.stringify([entry.project.key, entry.node.id]);
    if (this.requestedEntries.has(key)) return;
    this.requestedEntries.add(key);
    const epoch = this.epoch;
    this.serial = this.serial.then(async () => {
      if (epoch !== this.epoch || this.stopped) return;
      const result = await tree.request(entry.project, 'metadata/source', { node: entry.node.id });
      if (epoch !== this.epoch || this.stopped || !Array.isArray(result.sources)) return;
      for (const source of result.sources) {
        if (!isRecord(source) || !isWirePath(source.path) || !isRecord(source.role) || source.role.kind !== 'descriptor') continue;
        const local = nativePath(source.path);
        if (isAbsolute(local) || local.split(/[\\/]/).some(part => part === '..')) throw new Error('source outside project');
        this.queueFile(join(nativePath(entry.project.info.sourcePath), local));
      }
    }).catch(error => this.log(`support_object_failed ${String(error)}`));
  }

  /** A bounded request returns only touched files; no global inventory or giant settings update is needed. */
  private async queryFiles(paths: string[], epoch: number): Promise<void> {
    if (epoch !== this.epoch || this.stopped || !this.enabled) return;
    const active = new Set([this.tree, ...this.additional].flatMap(tree => tree?.projects ?? []));
    const snapshots = new Map([...this.snapshots].filter(([project]) => active.has(project)));
    for (const tree of [this.tree, ...this.additional]) if (tree) for (const project of tree.projects) {
      const selected = [...new Set(paths)].map(path => this.locate(path)).filter(item => item?.project === project);
      if (!selected.length) continue;
      const previous = snapshots.get(project);
      const current = previous?.generation === project.info.generation && previous?.eventSequence === project.info.eventSequence;
      const snapshot: Snapshot = current ? { ...previous, objects: new Map(previous.objects), files: [...previous.files] }
        : { generation: project.info.generation, eventSequence: project.info.eventSequence, objects: new Map(), files: [], diagnostics: [] };
      for (let start = 0; start < selected.length; start += 128) {
        const batch = selected.slice(start, start + 128);
        const response = await tree.request(project, 'metadata/supportFiles', { paths: batch.map(item => ({ encoding: 'utf-8', value: item!.relative })) });
        if (epoch !== this.epoch || this.stopped) return;
        if (!Array.isArray(response.objects) || !Array.isArray(response.files) || !Array.isArray(response.diagnostics) || response.files.length !== batch.length) throw new Error('invalid support files');
        for (const item of response.objects) {
          if (!isRecord(item) || typeof item.objectId !== 'string' || typeof item.uuid !== 'string' || typeof item.reason !== 'string' || !['locked', 'editableWithSupport', 'unrestricted', 'unknown'].includes(String(item.state))) throw new Error('invalid object policy');
          snapshot.objects.set(item.objectId, item as unknown as ObjectPolicy);
        }
        for (const [index, item] of response.files.entries()) {
          if (!isRecord(item) || !isWirePath(item.path) || nativePath(item.path) !== batch[index]!.relative || !Array.isArray(item.objects) || item.objects.some(id => typeof id !== 'string') || typeof item.readOnly !== 'boolean' || typeof item.mixed !== 'boolean' || typeof item.unknown !== 'boolean') throw new Error('invalid source policy');
          const path = join(nativePath(project.info.sourcePath), nativePath(item.path));
          snapshot.files = snapshot.files.filter(file => file.path !== path);
          snapshot.files.push({ path, objects: item.objects, readOnly: item.readOnly || item.unknown, mixed: item.mixed, unknown: item.unknown });
        }
        snapshot.diagnostics = response.diagnostics.map(String);
        snapshot.generation = project.info.generation; snapshot.eventSequence = project.info.eventSequence;
      }
      snapshots.set(project, snapshot);
    }
    await this.publish(snapshots, epoch, true, this.ownedRules());
  }

  /** Validate a complete batch before publishing it or writing settings. */
  private async refresh(epoch: number): Promise<void> {
    const tree = this.tree;
    if (epoch !== this.epoch) return;
    if (!this.enabled || !tree || !this.available) {
      if (!this.enabled || this.clearRestrictions) { await this.apply([], epoch); this.fileIndex.clear(); }
      this.changed.fire(undefined); this.repaint();
      return;
    }
    if (this.targeted) {
      const paths = [...this.fileIndex.values()].map(value => value.file.path);
      paths.push(...vscode.workspace.textDocuments.filter(document => document.uri.scheme === 'file').map(document => document.uri.fsPath));
      paths.push(...this.requestedFiles);
      this.requestedFiles.clear();
      await this.queryFiles(paths, epoch);
      return;
    }
    const snapshots = new Map<ProjectTree, Snapshot>();
    const baselineRules = this.ownedRules();
    let published = false;
    for (const context of [tree, ...this.additional]) for (const project of context.projects) {
      const objects = new Map<string, ObjectPolicy>();
      const files: FilePolicy[] = [];
      const diagnostics: string[] = [];
      const snapshot = { generation: project.info.generation, eventSequence: project.info.eventSequence, objects, files, diagnostics };
      snapshots.set(project, snapshot);
      let offset: number | null = 0;
      do {
        const result = await context.request(project, 'metadata/support', { offset });
        if (epoch !== this.epoch || this.stopped) return;
        snapshot.generation = project.info.generation;
        snapshot.eventSequence = project.info.eventSequence;
        if (!Array.isArray(result.objects) || !Array.isArray(result.files) || !Array.isArray(result.diagnostics)) throw new Error('invalid support snapshot');
        for (const item of result.objects) {
          if (!isRecord(item) || typeof item.objectId !== 'string' || typeof item.uuid !== 'string' || typeof item.reason !== 'string' || !['locked', 'editableWithSupport', 'unrestricted', 'unknown'].includes(String(item.state))) throw new Error('invalid object policy');
          objects.set(item.objectId, item as unknown as ObjectPolicy);
        }
        for (const item of result.files) {
          if (!isRecord(item) || !isWirePath(item.path) || !Array.isArray(item.objects) || item.objects.some(id => typeof id !== 'string') || typeof item.readOnly !== 'boolean' || typeof item.mixed !== 'boolean' || typeof item.unknown !== 'boolean') throw new Error('invalid source policy');
          const path = nativePath(item.path);
          if (path.split(/[\\/]/).some(part => part === '..') || /^(?:\/|[A-Za-z]:)/.test(path)) throw new Error('source outside project');
          files.push({ path: join(nativePath(project.info.sourcePath), path), objects: item.objects, readOnly: item.readOnly, mixed: item.mixed, unknown: item.unknown });
        }
        diagnostics.push(...result.diagnostics.map(String));
        if (result.nextOffset !== null && (!Number.isSafeInteger(result.nextOffset) || (result.nextOffset as number) <= offset)) throw new Error('invalid support cursor');
        offset = result.nextOffset as number | null;
        // Protect the first confirmed files without repeatedly rewriting large editor settings.
        if (!published) {
          await this.publish(snapshots, epoch, false, baselineRules);
          if (epoch !== this.epoch || this.stopped) return;
          published = true;
        }
        // Yield between bounded pages so file-change notifications can cancel stale work.
        await new Promise(resolve => setTimeout(resolve, 0));
      } while (offset !== null);
    }
    await this.publish(snapshots, epoch, true, baselineRules);
    if (epoch === this.epoch && !this.stopped) {
      this.loading = false;
      this.repaint();
    }
  }

  /** Publish validated partial snapshots; remove old restrictions only after a complete pass. */
  private async publish(snapshots: Map<ProjectTree, Snapshot>, epoch: number, complete: boolean, baselineRules: string[]): Promise<void> {
    if (epoch !== this.epoch || this.stopped) return;
    const previousRoots = this.context.workspaceState.get<Record<string, string>>('supportRoots.v1', {});
    const nextRoots: Record<string, string> = complete ? {} : { ...previousRoots };
    const preserve: string[] = [];
    const pendingSources = Object.keys(previousRoots).filter(source => {
      const folder = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(source));
      return !!folder && this.pendingFolders.includes(folder.uri.fsPath);
    });
    for (const source of pendingSources) {
      preserve.push(readonlyPattern(source) + '/');
      nextRoots[source] = previousRoots[source]!;
    }
    if (!complete) {
      for (const source of Object.keys(previousRoots)) preserve.push(readonlyPattern(source) + '/');
      for (const project of snapshots.keys()) preserve.push(readonlyPattern(nativePath(project.info.sourcePath)) + '/');
    }
    for (const [project, snapshot] of snapshots) {
      const source = nativePath(project.info.sourcePath);
      const root = snapshot.objects.get(project.info.root.objectId);
      const sameRoot = !!root && previousRoots[source] === root.uuid;
      // A file-only response need not contain the root object; retain provenance during reconnects.
      if (this.targeted) nextRoots[source] = `targeted:${project.info.root.objectId}`;
      if (root && (root.state !== 'unknown' || sameRoot)) nextRoots[source] = root.uuid;
      if (sameRoot && snapshot.diagnostics.some(value => value.startsWith('support_read:') || value.startsWith('descriptor_unavailable:') || value.startsWith('source_unavailable:'))) {
        preserve.push(readonlyPattern(source) + '/');
      }
    }
    const patterns = [...snapshots].flatMap(([project, snapshot]) => readonlyPatterns(nativePath(project.info.sourcePath), snapshot.files.filter(file => file.readOnly).map(file => file.path)));
    const retained = baselineRules.filter(pattern => preserve.some(prefix => pattern.startsWith(prefix)));
    await this.apply([...patterns, ...retained], epoch);
    if (epoch !== this.epoch || this.stopped) return;
    await this.context.workspaceState.update('supportRoots.v1', nextRoots);
    if (epoch !== this.epoch || this.stopped) return;
    const previouslyLocked = new Set([...this.fileIndex].filter(([, value]) => value.file.readOnly).map(([uri]) => uri));
    const pendingFiles = [...this.fileIndex].filter(([, value]) => !complete || pendingSources.some(source => value.file.path.startsWith(join(source, '/'))));
    this.snapshots.clear(); this.fileIndex.clear(); this.mixedObjects.clear();
    for (const [uri, value] of pendingFiles) this.fileIndex.set(uri, value);
    for (const [project, snapshot] of snapshots) {
      this.snapshots.set(project, snapshot);
      this.mixedObjects.set(project, new Set(snapshot.files.filter(file => file.mixed).flatMap(file => file.objects)));
      for (const file of snapshot.files) this.fileIndex.set(vscode.Uri.file(file.path).toString(), { file, snapshot });
    }
    this.changed.fire(undefined); this.repaint();
    if (this.targeted) for (const editor of vscode.window.visibleTextEditors) {
      const policy = this.fileIndex.get(editor.document.uri.toString())?.file;
      if (policy?.readOnly) void this.protectEditor(editor);
    }
    for (const document of vscode.workspace.textDocuments) {
      if (document.isDirty && !previouslyLocked.has(document.uri.toString()) && [...snapshots.values()].some(snapshot => snapshot.files.some(file => file.readOnly && file.path === document.uri.fsPath))) {
        void vscode.window.showWarningMessage(supportText('dirty'));
      }
    }
  }

  /** Single-folder settings require a resource; multi-folder settings belong to the workspace. */
  private settings(): vscode.WorkspaceConfiguration {
    const resource = vscode.workspace.workspaceFile ? undefined : vscode.workspace.workspaceFolders?.[0]?.uri;
    return vscode.workspace.getConfiguration('files', resource);
  }

  /** Inspect only the scope we own, not merged user or folder overrides. */
  private readRules(): Record<string, boolean> {
    return this.settings().inspect<Record<string, boolean>>('readonlyInclude')?.workspaceValue ?? {};
  }

  /** Resolve journal identities against existing settings instead of storing megabytes of duplicate paths. */
  private ownedRules(): string[] {
    const hashes = this.context.workspaceState.get<string[]>('supportReadonlyRules.v2');
    if (!hashes) return this.context.workspaceState.get<string[]>('supportReadonlyRules.v1', []);
    const owned = new Set(hashes);
    return Object.keys(this.readRules()).filter(pattern => owned.has(this.ruleHash(pattern)));
  }

  /** Hash only ownership identities; settings still contain the exact reversible file patterns. */
  private ruleHash(pattern: string): string { return createHash('sha256').update(pattern).digest('base64'); }

  /** Save recovery identities before modifying settings and migrate the former full-path journal once. */
  private async saveOwnedRules(patterns: string[]): Promise<void> {
    await this.context.workspaceState.update('supportReadonlyRules.v2', [...new Set(patterns.map(pattern => this.ruleHash(pattern)))]);
    if (this.context.workspaceState.get('supportReadonlyRules.v1') !== undefined) {
      await this.context.workspaceState.update('supportReadonlyRules.v1', undefined);
    }
  }

  /** Keep exact absolute patterns in one workspace scope, including multi-folder workspaces. */
  private async apply(patterns: string[], epoch?: number): Promise<void> {
    const previous = this.ownedRules();
    const desired = patterns;
    let current = this.readRules();
    let merged = reconcileRules(current, previous, desired);
    // Save a recovery journal before writing configuration, then reread after the await.
    await this.saveOwnedRules([...previous, ...merged.owned]);
    if (epoch !== undefined && epoch !== this.epoch) return;
    current = this.readRules();
    merged = reconcileRules(current, previous, desired);
    let expected = merged.rules;
    const externallyEdited = new Set<string>();
    for (let retry = 0; retry < 3 && JSON.stringify(current) !== JSON.stringify(expected); retry++) {
      const writing = { baseline: current, expected, edits: new Map<string, boolean | undefined>() };
      this.writing = writing;
      try {
        await this.settings().update('readonlyInclude', Object.keys(expected).length ? expected : undefined, vscode.ConfigurationTarget.Workspace);
        await new Promise(resolve => setTimeout(resolve, 0));
      } finally { this.writing = undefined; }
      current = this.readRules();
      const next = { ...current };
      for (const [key, value] of writing.edits) {
        externallyEdited.add(key);
        if (current[key] !== expected[key]) continue;
        if (value === undefined) delete next[key]; else next[key] = value;
      }
      expected = next;
    }
    merged.owned = merged.owned.filter(key => !externallyEdited.has(key));
    await this.saveOwnedRules(merged.owned);
  }

  /** Deactivation awaits cleanup; no writeable-in-session command is ever invoked. */
  async shutdown(): Promise<void> {
    this.stopped = true; this.epoch++; clearTimeout(this.timer); clearTimeout(this.fileTimer);
    await this.serial;
    await this.apply([]);
    this.subscription.dispose(); this.settingsSubscription.dispose(); this.documentSubscription.dispose(); this.editorSubscription.dispose(); this.changed.dispose();
  }
}
