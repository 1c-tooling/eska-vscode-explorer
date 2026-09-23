import * as vscode from 'vscode';
import { join } from 'node:path';
import { isRecord, isWirePath } from './protocol.js';
import { nativePath } from './source.js';
import type { MetadataTree, ProjectTree, TreeEntry } from './tree.js';
import { reconcileRules, readonlyPattern, readonlyPatterns } from './support-settings.js';

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
  private serial: Promise<void> = Promise.resolve();
  private readonly snapshots = new Map<ProjectTree, Snapshot>();
  private readonly changed = new vscode.EventEmitter<vscode.Uri[] | undefined>();
  readonly onDidChangeFileDecorations = this.changed.event;
  private readonly subscription: vscode.Disposable;
  private readonly settingsSubscription: vscode.Disposable;
  private writing: { baseline: Record<string, boolean>; expected: Record<string, boolean>; edits: Map<string, boolean | undefined> } | undefined;
  private stopped = false;
  private available = false;
  private clearRestrictions = false;
  private requested: string | undefined;
  private readonly mixedObjects = new Map<ProjectTree, Set<string>>();
  private readonly fileIndex = new Map<string, { file: FilePolicy; snapshot: Snapshot }>();

  constructor(private readonly context: vscode.ExtensionContext, private readonly repaint: () => void, private readonly log: (text: string) => void) {
    this.subscription = vscode.window.registerFileDecorationProvider(this);
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

  /** A session change invalidates every queued response before any setting is written. */
  setTree(tree: MetadataTree | undefined, available: boolean, clearRestrictions = false): void {
    this.tree = tree; this.available = available; this.epoch++; this.requested = undefined;
    this.clearRestrictions = clearRestrictions;
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
    const key = JSON.stringify([this.available, this.pendingFolders, [this.tree, ...this.additional].filter(Boolean).map(tree => [tree?.session.sessionId, tree?.projects.map(project => [project.info.generation, project.info.eventSequence])])]);
    if (key === this.requested) return;
    this.requested = key;
    const epoch = ++this.epoch;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.serial = this.serial.then(() => this.refresh(epoch)).catch(error => { this.requested = undefined; this.log(`support_update_failed ${String(error)}`); });
    }, 100);
  }

  /** Resolve a tree object's own status, leaving virtual groups undecorated. */
  object(entry: TreeEntry): ObjectPolicy | undefined {
    if (entry.node.id.kind === 'collection') return undefined;
    const id = entry.node.id.kind === 'object' ? entry.node.id.objectId : entry.node.id.owner;
    const snapshot = this.snapshots.get(entry.project);
    const current = snapshot?.generation === entry.project.info.generation && snapshot?.eventSequence === entry.project.info.eventSequence;
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

  /** A single short badge is supported by the public API in all native tree themes. */
  decoration(entry: TreeEntry): vscode.FileDecoration | undefined {
    const policy = this.object(entry);
    if (!policy || policy.state === 'unrestricted') return undefined;
    return new vscode.FileDecoration(policy.state === 'locked' ? '🔒' : policy.state === 'editableWithSupport' ? 'S' : '?', this.explanation(entry));
  }

  /** Standard Explorer uses real file URIs and can request explanations before our tree is visible. */
  provideFileDecoration(uri: vscode.Uri): vscode.FileDecoration | undefined {
    if (uri.scheme !== 'file') return undefined;
    const current = this.fileIndex.get(uri.toString());
    if (current) {
      const { file, snapshot } = current;
      const project = [...this.snapshots].find(([, value]) => value === snapshot)?.[0];
      if (!project || project.info.generation !== snapshot.generation || project.info.eventSequence !== snapshot.eventSequence) return new vscode.FileDecoration('?', supportText('unknown'));
      if (file.unknown) return new vscode.FileDecoration('?', supportText('unknown') + ': ' + snapshot.diagnostics.join('; '));
      if (file.readOnly) return new vscode.FileDecoration('🔒', supportText(file.mixed ? 'mixed' : 'vendorLocked'));
      if (file.objects.some(id => snapshot.objects.get(id)?.state === 'editableWithSupport')) return new vscode.FileDecoration('S', supportText('editableWithSupport'));
    }
    return undefined;
  }

  /** Validate a complete batch before publishing it or writing settings. */
  private async refresh(epoch: number): Promise<void> {
    const tree = this.tree;
    if (epoch !== this.epoch) return;
    if (!tree || !this.available) {
      if (this.clearRestrictions) { await this.apply([], epoch); this.fileIndex.clear(); }
      this.changed.fire(undefined); this.repaint();
      return;
    }
    const snapshots = new Map<ProjectTree, Snapshot>();
    for (const context of [tree, ...this.additional]) for (const project of context.projects) {
      const objects = new Map<string, ObjectPolicy>();
      const files: FilePolicy[] = [];
      const diagnostics: string[] = [];
      let offset: number | null = 0;
      do {
        const result = await context.request(project, 'metadata/support', { offset });
        if (epoch !== this.epoch || this.stopped) return;
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
      } while (offset !== null);
      snapshots.set(project, { generation: project.info.generation, eventSequence: project.info.eventSequence, objects, files, diagnostics });
    }
    if (epoch !== this.epoch || this.stopped) return;
    const previousRoots = this.context.workspaceState.get<Record<string, string>>('supportRoots.v1', {});
    const nextRoots: Record<string, string> = {};
    const preserve: string[] = [];
    const pendingSources = Object.keys(previousRoots).filter(source => {
      const folder = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(source));
      return !!folder && this.pendingFolders.includes(folder.uri.fsPath);
    });
    for (const source of pendingSources) {
      preserve.push(readonlyPattern(source) + '/');
      nextRoots[source] = previousRoots[source]!;
    }
    for (const [project, snapshot] of snapshots) {
      const source = nativePath(project.info.sourcePath);
      const root = snapshot.objects.get(project.info.root.objectId);
      const sameRoot = !!root && previousRoots[source] === root.uuid;
      if (root && (root.state !== 'unknown' || sameRoot)) nextRoots[source] = root.uuid;
      if (sameRoot && snapshot.diagnostics.some(value => value.startsWith('support_read:') || value.startsWith('descriptor_unavailable:') || value.startsWith('source_unavailable:'))) {
        preserve.push(readonlyPattern(source) + '/');
      }
    }
    await this.apply([...snapshots].flatMap(([project, snapshot]) => readonlyPatterns(nativePath(project.info.sourcePath), snapshot.files.filter(file => file.readOnly).map(file => file.path))), epoch, preserve);
    if (epoch !== this.epoch || this.stopped) return;
    await this.context.workspaceState.update('supportRoots.v1', nextRoots);
    if (epoch !== this.epoch || this.stopped) return;
    const previouslyLocked = new Set([...this.fileIndex].filter(([, value]) => value.file.readOnly).map(([uri]) => uri));
    const pendingFiles = [...this.fileIndex].filter(([, value]) => pendingSources.some(source => value.file.path.startsWith(join(source, '/'))));
    this.snapshots.clear(); this.fileIndex.clear(); this.mixedObjects.clear();
    for (const [uri, value] of pendingFiles) this.fileIndex.set(uri, value);
    for (const [project, snapshot] of snapshots) {
      this.snapshots.set(project, snapshot);
      this.mixedObjects.set(project, new Set(snapshot.files.filter(file => file.mixed).flatMap(file => file.objects)));
      for (const file of snapshot.files) this.fileIndex.set(vscode.Uri.file(file.path).toString(), { file, snapshot });
    }
    this.changed.fire(undefined); this.repaint();
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

  /** Keep exact absolute patterns in one workspace scope, including multi-folder workspaces. */
  private async apply(patterns: string[], epoch?: number, preserve: string[] = []): Promise<void> {
    const key = 'supportReadonlyRules.v1';
    const previous = this.context.workspaceState.get<string[]>(key, []);
    const desired = [...patterns, ...previous.filter(pattern => preserve.some(prefix => pattern.startsWith(prefix)))];
    let current = this.readRules();
    let merged = reconcileRules(current, previous, desired);
    // Save a recovery journal before writing configuration, then reread after the await.
    await this.context.workspaceState.update(key, [...new Set([...previous, ...merged.owned])]);
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
    await this.context.workspaceState.update(key, merged.owned);
  }

  /** Deactivation awaits cleanup; no writeable-in-session command is ever invoked. */
  async shutdown(): Promise<void> {
    this.stopped = true; this.epoch++; clearTimeout(this.timer);
    await this.serial;
    await this.apply([]);
    this.subscription.dispose(); this.settingsSubscription.dispose(); this.changed.dispose();
  }
}
