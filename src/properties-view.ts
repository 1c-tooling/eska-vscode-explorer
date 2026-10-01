import { resolve } from "node:path";
import { nativePath } from "./source.js";
import { editingSchema, fieldId, propertyChange, type EditingView, type PropertyChange } from "./property-editing.js";
import { pickPropertyValue } from "./property-value-picker.js";
import * as vscode from "vscode";
import { message } from "./messages.js";
import { ExplorerError, isRecord } from "./protocol.js";
import { objectSynonym, propertyChoices, type PropertyChoice } from "./properties.js";
import { presentedItems, referenceTargets } from "./property-presentation.js";
import { revealHit } from "./search.js";
import { metadataIcons } from "./icons.js";
import { picturePreview, type PicturePreview } from "./picture.js";
import { nodeKey, type MetadataTree, type TreeEntry } from "./tree.js";

type Language = "ru-RU" | "en-US";

interface ViewState {
  type: "state";
  revision: number;
  title: string;
  path: string;
  status: "loading" | "ready" | "stale" | "error";
  notice: string;
  labels: Record<string, string>;
  language: Language;
  icons: Record<string, Record<string, string>>;
  picture: PicturePreview | { status: "loading" } | undefined;
  editing: EditingView;
  properties: Pick<PropertyChoice, "index" | "label" | "key" | "caption" | "qualifiers" | "value" | "description" | "presentation">[];
}

/** One editor tab belongs to one project-scoped metadata identity. */
class PropertyTab implements vscode.Disposable {
  readonly panel: vscode.WebviewPanel;
  private choices: PropertyChoice[] = [];
  private picture: PicturePreview | undefined;
  private ready = false;
  private disposed = false;
  private revision = 0;
  private dirty = true;
  private version = "";
  private controller: AbortController | undefined;
  private state: ViewState;
  private editor: EditingView = { unlocked: false, busy: false, blocked: false, schema: undefined, drafts: {}, draftTitles: {} };
  private readonly pendingEdits = new Map<string, PropertyChange>();
  private pendingInvalidation = false;
  private lockAfterSave = false;
  private refreshing = false;

  constructor(private readonly context: vscode.ExtensionContext, private tree: MetadataTree, private entry: TreeEntry,
    private readonly language: () => Language, private readonly currentTree: () => MetadataTree | undefined,
    private readonly openXml: (entry: TreeEntry, choice: PropertyChoice) => Promise<void>,
    private readonly openReference: (tree: MetadataTree, entry: TreeEntry) => Promise<void>,
    private readonly closed: () => void) {
    const roots = [vscode.Uri.joinPath(context.extensionUri, "resources", "properties"),
      vscode.Uri.joinPath(context.extensionUri, "resources", "icons")];
    const label = entry.node.label.kind === "name" ? entry.node.label.text : entry.node.label.translations[language()];
    const title = `${label} · ${message(vscode.env.language, "properties")}`;
    this.panel = vscode.window.createWebviewPanel("eska.explorer.properties", title, vscode.ViewColumn.Active,
      { enableScripts: true, localResourceRoots: roots });
    this.state = this.makeState("loading", message(vscode.env.language, "propertyLoading"));
    this.panel.webview.html = this.html();
    this.panel.onDidDispose(() => this.dispose());
    this.panel.onDidChangeViewState(() => {
      if (this.panel.visible && this.dirty && this.tree === this.currentTree()) void this.load();
    });
    this.panel.webview.onDidReceiveMessage((input: unknown) => { void this.receive(input); });
    this.updateTitle();
  }

  /** Existing object tabs return to focus and bind to the freshest tree entry. */
  async show(tree: MetadataTree, entry: TreeEntry): Promise<void> {
    this.tree = tree;
    this.entry = entry;
    // Start before reveal: its visibility event must not schedule a second read.
    const loading = this.editor.unlocked || Object.keys(this.editor.drafts).length ? Promise.resolve() : this.load();
    this.panel.reveal(this.panel.viewColumn);
    await loading;
  }

  /** Remember hidden invalidations and ignore presentation-only tree changes. */
  changed(tree: MetadataTree, entries: TreeEntry[] | undefined): void {
    if (this.disposed || this.tree !== tree || this.version === this.projectVersion()) return;
    this.version = this.projectVersion();
    if (entries && !presentedItems(this.choices).some(item => item.status)) {
      let cursor: TreeEntry | undefined = this.entry;
      while (cursor && !entries.includes(cursor)) cursor = tree.parent(cursor);
      if (!cursor) return;
    }
    if (this.refreshing) return;
    if (this.editor.busy) { this.pendingInvalidation = true; return; }
    if (this.editor.unlocked || Object.keys(this.editor.drafts).length) {
      void this.checkExternalChange();
      return;
    }
    this.dirty = true;
    this.controller?.abort();
    this.revision++;
    this.state = this.makeState("loading", message(vscode.env.language, "propertyLoading"));
    this.publish();
    if (this.panel.visible) void this.load();
  }

  /** Ordered backend tokens distinguish data changes from lazy branch repainting. */
  private projectVersion(): string {
    const { generation, eventSequence } = this.entry.project.info;
    return `${generation}:${eventSequence}`;
  }

  /** Show the current status again when VS Code recreates a hidden webview. */
  private publish(): void {
    if (this.ready && !this.disposed) void this.panel.webview.postMessage(this.state);
  }

  /** Read only this object's properties and ignore requests superseded by refresh or disposal. */
  async load(): Promise<void> {
    if (this.disposed || this.editor.busy) return;
    this.dirty = false;
    this.version = this.projectVersion();
    this.controller?.abort();
    const controller = new AbortController();
    this.controller = controller;
    const revision = ++this.revision;
    const tree = this.tree;
    const entry = this.entry;
    this.picture = undefined;
    this.state = this.makeState("loading", message(vscode.env.language, "propertyLoading"));
    this.publish();
    try {
      if (tree !== this.currentTree() || entry.project.nodes.get(nodeKey(entry.node.id)) !== entry
        || entry.node.id.kind !== "object") throw new ExplorerError("obsolete");
      if (this.editor.unlocked) {
        this.editor.schema = editingSchema(await tree.request(entry.project, "metadata/propertyEditing", { objectId: entry.node.id.objectId }, controller.signal));
        if (controller.signal.aborted || this.disposed || revision !== this.revision) return;
      }
      const result = await tree.request(entry.project, "metadata/properties", { objectId: entry.node.id.objectId }, controller.signal);
      if (controller.signal.aborted || this.disposed || revision !== this.revision) return;
      if (tree !== this.currentTree() || entry.project.nodes.get(nodeKey(entry.node.id)) !== entry) throw new ExplorerError("obsolete");
      if (this.editor.unlocked) {
        this.editor.blocked = false;
        this.pendingEdits.clear();
      }
      this.choices = propertyChoices(result, vscode.env.language);
      this.picture = picturePreview(result.picture);
      this.editor.blocked = false;
      this.updateTitle();
      this.state = this.makeState("ready", "");
      this.publish();
    } catch (error) {
      if (controller.signal.aborted || this.disposed || revision !== this.revision) return;
      const failure = error instanceof ExplorerError ? error : new ExplorerError("requestFailed");
      if (this.editor.unlocked && this.choices.length) {
        this.editor.blocked = true;
        this.state = this.makeState("ready", message(vscode.env.language, "propertyConflict"));
        this.publish();
        return;
      }
      this.choices = [];
      this.updateTitle();
      this.state = this.makeState(failure.code === "obsolete" ? "stale" : "error", message(vscode.env.language,
        failure.code === "obsolete" ? "propertyStale" : failure.code));
      this.publish();
    }
  }

  /** Connection replacement leaves the tab visible but prevents stale XML navigation. */
  stale(): void {
    this.editor.unlocked = false;
    this.editor.blocked = true;
    this.pendingEdits.clear();
    this.controller?.abort();
    this.dirty = false;
    this.revision++;
    this.choices = [];
    this.picture = undefined;
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

  /** Bind XML actions to the snapshot actually displayed, including its original indexes. */
  private async receive(input: unknown): Promise<void> {
    if (!isRecord(input) || this.disposed) return;
    if (input.type === "ready") {
      this.ready = true;
      this.publish();
    } else if (input.type === "refresh") {
      await this.refresh();
    } else if (["toggleLock", "draft", "commit", "applyDraft", "cancelDraft", "pickType", "pickReference", "pickValue", "undo", "redo"].includes(String(input.type))) {
      await this.edit(input);
    } else if (input.type === "openReference" && typeof input.target === "string"
      && input.revision === this.state.revision && this.state.status === "ready" && !this.editor.blocked
      && this.tree === this.currentTree() && referenceTargets(this.choices).has(input.target)) {
      await this.followReference(input.target);
    } else if (input.type === "openXml" && input.revision === this.state.revision && Number.isSafeInteger(input.index)) {
      const choice = this.choices[input.index as number];
      if (choice && this.state.status === "ready" && !this.editor.blocked && this.tree === this.currentTree()) {
        await this.openXml(this.entry, choice);
      }
    }
  }

  /** Explicit reread bypasses a stale descriptor cache even before its watcher event arrives. */
  private async refresh(): Promise<void> {
    if (this.editor.busy || this.refreshing) return;
    this.refreshing = true;
    this.editorNotice("propertyLoading");
    try {
      if (this.editor.unlocked || this.editor.blocked) {
        await this.tree.request(this.entry.project, "metadata/refresh", { node: this.entry.node.id });
      }
      await this.load();
    } catch {
      this.blockEditing("propertyConflict");
    } finally {
      this.refreshing = false;
      this.state = this.makeState(this.state.status, this.state.notice);
      this.publish();
    }
  }

  /** Read external changes without discarding drafts or mistaking our own watcher event for a conflict. */
  private async checkExternalChange(): Promise<void> {
    const expected = this.editor.schema?.snapshot;
    if (!expected || this.entry.node.id.kind !== "object") return;
    try {
      const result = editingSchema(await this.tree.request(this.entry.project, "metadata/propertyEditing", { objectId: this.entry.node.id.objectId }));
      if (this.disposed || expected !== this.editor.schema?.snapshot) return;
      if (result.snapshot !== expected || !result.writable) this.blockEditing("propertyConflict");
    } catch { if (!this.disposed) this.blockEditing("propertyConflict"); }
  }

  /** Keep the displayed snapshot and draft values intact until an explicit reread. */
  private blockEditing(key: "propertyConflict" | "propertyWriteUnknown" | "propertyBusy" | "propertyRecovery"): void {
    this.editor.blocked = true;
    this.pendingEdits.clear();
    this.editorNotice(key);
  }

  /** Editing status updates reuse the current values rather than starting another source load. */
  private editorNotice(key: Parameters<typeof message>[1]): void {
    this.state = this.makeState(this.state.status, message(vscode.env.language, key));
    this.publish();
  }

  /** Bind every proposal to the advertised field and displayed revision before queuing it. */
  private async edit(input: Record<string, unknown>): Promise<void> {
    if (this.refreshing || input.revision !== this.revision || this.state.status !== "ready" || this.tree !== this.currentTree()
      || this.entry.node.id.kind !== "object") return;
    if (input.type === "toggleLock") {
      if (this.editor.busy) { this.lockAfterSave = true; return; }
      if (this.editor.unlocked) {
        this.editor.unlocked = false;
        this.editorNotice("propertyReadOnly");
        return;
      }
      try {
        const revision = this.revision;
        const result = await this.tree.request(this.entry.project, "metadata/propertyEditing", { objectId: this.entry.node.id.objectId });
        if (revision !== this.revision || this.disposed) return;
        this.editor.schema = editingSchema(result);
        if (!this.editor.schema.writable || !this.editor.schema.fields.length || !vscode.workspace.isTrusted) { this.editorNotice("propertyLocked"); return; }
        this.editor.unlocked = true;
        this.editor.blocked = false;
        this.editorNotice("propertyEditingHint");
      } catch { this.editorNotice("propertyLocked"); }
      return;
    }
    if (!this.editor.unlocked || !this.editor.schema) return;
    if (input.type === "undo" || input.type === "redo") {
      if (Object.keys(this.editor.drafts).length) { this.editorNotice("propertyDraftsFirst"); return; }
      await this.writeEdit(undefined, undefined, input.type);
      return;
    }
    const field = this.editor.schema.fields[Number(input.field)];
    if (!Number.isSafeInteger(input.field) || !field) return;
    const id = fieldId(field.path);
    if (input.type === "cancelDraft") {
      delete this.editor.drafts[id];
      delete this.editor.draftTitles[id];
      this.pendingEdits.delete(id);
      this.state = this.makeState(this.state.status, this.state.notice);
      this.publish();
      return;
    }
    if (input.type === "applyDraft") {
      const change = this.editor.drafts[id];
      if (change) await this.writeEdit(id, change);
      return;
    }
    if (input.type === "pickType") {
      if (this.editor.busy || this.editor.blocked || field.schema.kind !== "dataType") return;
      try {
        const revision = this.revision;
        const result = await this.tree.request(this.entry.project, "metadata/propertyTypeChoices", { objectId: this.entry.node.id.objectId, path: field.path });
        const options = Array.isArray(result.choices) ? result.choices.filter(isRecord).filter(item => isRecord(item.key) && isRecord(item.caption)) : [];
        const selected = await vscode.window.showQuickPick(options.map(item => ({
          label: String((item.caption as Record<string, unknown>)[this.language()] ?? ""),
          description: item.metadataKind ? String((item.key as Record<string, unknown>).name).split(".").slice(1).join(".") : "", item,
        })), { title: message(vscode.env.language, "propertyChangeType"), matchOnDescription: true });
        if (!selected || revision !== this.revision || this.disposed) return;
        const change = { kind: "dataType", key: selected.item.key } as PropertyChange;
        this.editor.drafts[id] = change;
        this.editor.draftTitles[id] = selected.label;
        await this.writeEdit(id, change);
      } catch { this.editorNotice("requestFailed"); }
      return;
    }
    if (input.type === "pickReference") {
      if (this.editor.busy || this.editor.blocked || field.schema.kind !== "reference") return;
      try {
        const revision = this.revision;
        const result = await this.tree.request(this.entry.project, "metadata/propertyReferenceChoices", { objectId: this.entry.node.id.objectId, path: field.path });
        const options = (Array.isArray(result.choices) ? result.choices : []).filter(isRecord)
          .filter(item => typeof item.value === "string" && isRecord(item.caption))
          .map(item => ({ label: String((item.caption as Record<string, unknown>)[this.language()] ?? item.value), value: item.value as string }));
        if (field.schema.nullable) options.unshift({ label: message(vscode.env.language, "propertyUnset"), value: "" });
        const selected = await vscode.window.showQuickPick(options, { title: message(vscode.env.language, "propertyChooseReference"), matchOnDescription: true });
        if (!selected || revision !== this.revision || this.disposed) return;
        const change: PropertyChange = { kind: "text", value: selected.value };
        this.editor.drafts[id] = change;
        this.editor.draftTitles[id] = selected.label;
        await this.writeEdit(id, change);
      } catch { this.editorNotice("requestFailed"); }
      return;
    }
    if (input.type === "pickValue") {
      if (this.editor.busy || this.editor.blocked || field.schema.kind !== "value") return;
      const revision = this.revision, objectId = this.entry.node.id.objectId;
      try {
        const selected = await pickPropertyValue(vscode.window, field, this.language(), this.editor.drafts[id],
          type => this.tree.request(this.entry.project, "metadata/propertyValueChoices", { objectId, path: field.path, key: type.key }));
        if (!selected || revision !== this.revision || this.disposed) return;
        this.editor.drafts[id] = selected.change;
        this.editor.draftTitles[id] = selected.title;
        this.state = this.makeState(this.state.status, this.state.notice);
        this.publish();
        await this.writeEdit(id, selected.change);
      } catch { this.editorNotice("requestFailed"); }
      return;
    }
    const change = propertyChange(input.change, field);
    if (!change) return;
    if (change.kind === "text" && change.value === field.value) delete this.editor.drafts[id];
    else this.editor.drafts[id] = change;
    // The host retains every draft, including when VS Code destroys a hidden webview.
    this.state = this.makeState(this.state.status, this.state.notice);
    if (input.type === "commit" && this.editor.drafts[id]) {
      if (this.editor.busy) this.pendingEdits.set(id, change);
      else await this.writeEdit(id, change);
    }
  }

  /** Never overwrite a dirty text editor; writes execute once and require an exact backend snapshot. */
  private async writeEdit(id?: string, change?: PropertyChange, direction?: "undo" | "redo"): Promise<void> {
    const schema = this.editor.schema;
    if (!schema || !schema.writable || this.editor.busy || this.editor.blocked || !this.editor.unlocked
      || this.entry.node.id.kind !== "object" || !vscode.workspace.isTrusted) return;
    const field = schema.fields.find(field => fieldId(field.path) === id);
    if (!direction && (!field || !change)) return;
    const path = resolve(nativePath(this.entry.project.info.sourcePath), nativePath(schema.source));
    if (vscode.workspace.textDocuments.some(document => document.isDirty && resolve(document.uri.fsPath) === path)) {
      this.editorNotice("propertyDirtyXml"); return;
    }
    this.editor.busy = true;
    this.editorNotice("propertySaving");
    try {
      const result = await this.tree.request(this.entry.project, direction ? "metadata/undoProperty" : "metadata/updateProperty", {
        objectId: this.entry.node.id.objectId, snapshot: schema.snapshot,
        ...(direction ? { direction } : { path: field?.path, change }),
      });
      if (this.disposed || this.tree !== this.currentTree()) return;
      this.editor.schema = editingSchema(result.editing);
      if (id && JSON.stringify(this.editor.drafts[id]) === JSON.stringify(change)) {
        delete this.editor.drafts[id];
        delete this.editor.draftTitles[id];
      }
      this.choices = propertyChoices(result, vscode.env.language);
      this.picture = picturePreview(result.picture);
      this.revision++;
      this.updateTitle();
      this.editorNotice("propertySaved");
    } catch (error) {
      if (this.disposed) return;
      const domain = error instanceof ExplorerError ? error.domain : undefined;
      if (domain === "property_dependency") {
        const property = error instanceof ExplorerError ? error.details?.property : undefined;
        const choice = isRecord(property) ? this.choices.find(choice => choice.key.name === property.name
          && choice.key.namespace === property.namespace) : undefined;
        this.state = this.makeState(this.state.status, message(vscode.env.language, "propertyDependency",
          choice?.caption?.[this.language()] ?? choice?.label ?? message(vscode.env.language, "properties")));
        this.publish();
      } else if (domain === "property_edit_busy") this.blockEditing("propertyBusy");
      else if (domain === "property_recovery_required") this.blockEditing("propertyRecovery");
      else if (domain === "property_invalid") this.editorNotice("propertyInvalid");
      else if (domain === "property_unsupported" || domain === "property_read_only") this.editorNotice("propertyLocked");
      else this.blockEditing(domain === "property_conflict" || domain === "stale_generation" ? "propertyConflict" : "propertyWriteUnknown");
      this.pendingEdits.clear();
    } finally {
      this.editor.busy = false;
      if (this.lockAfterSave) { this.lockAfterSave = false; this.editor.unlocked = false; this.pendingEdits.clear(); }
      if (!this.disposed) {
        this.state = this.makeState(this.state.status, this.state.notice);
        this.publish();
        if (this.pendingInvalidation) { this.pendingInvalidation = false; await this.checkExternalChange(); }
        const next = this.pendingEdits.entries().next().value;
        if (next && !this.editor.blocked) { this.pendingEdits.delete(next[0]); await this.writeEdit(...next); }
      }
    }
  }

  /** Revalidate ancestry in the same project and discard navigation overtaken by refresh. */
  private async followReference(target: string): Promise<void> {
    const revision = this.revision;
    const tree = this.tree;
    try {
      const entry = await revealHit(tree, this.entry.project, { objectId: target, node: { kind: "object", objectId: target } }, this.controller?.signal);
      if (!this.disposed && revision === this.revision && tree === this.currentTree()) await this.openReference(tree, entry);
    } catch (error) {
      if (this.disposed || revision !== this.revision || tree !== this.currentTree()) return;
      const failure = error instanceof ExplorerError ? error : new ExplorerError("requestFailed");
      this.state = this.makeState("ready", message(vscode.env.language, failure.code));
      this.publish();
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
      type: "state", revision: this.revision, title: heading.title, path: heading.path, status, notice,
      language: this.language(), editing: { ...this.editor, busy: this.editor.busy || this.refreshing,
        drafts: { ...this.editor.drafts }, draftTitles: { ...this.editor.draftTitles } },
      icons: this.icons(),
      picture: status === "ready" ? this.picture
        : status === "loading" && this.entry.node.metadataKind === "common-picture" ? { status: "loading" } : undefined,
      labels: {
        unlock: text("propertyUnlock"), lock: text("propertyLock"), editing: text("propertyEditing"),
        undo: text("propertyUndo"), redo: text("propertyRedo"), apply: text("propertyApply"), cancel: text("propertyCancel"),
        changeType: text("propertyChangeType"), unchanged: text("propertyOtherValues"),
        chooseReference: text("propertyChooseReference"), unset: text("propertyUnset"),
        chooseValue: text("propertyChooseValue"),
        notEditable: text("propertyNotEditable"), saved: text("propertySaved"),
        properties: text("properties"), search: text("propertySearch"), refresh: text("propertyRefresh"),
        openXml: text("openXml"), empty: text("propertyEmpty"), noMatches: text("propertyNoMatches"),
        readOnly: text("propertyReadOnly"), fields: text("propertyFields", "{0}"),
        xmlOnly: text("propertyXmlOnly"), count: text("propertyCount", "{0}"),
        items: text("propertyItems", "{0}"), item: text("propertyItem", "{0}"),
        enabled: text("propertyEnabled", "{0}", "{1}"),
        referenceMissing: text("propertyReferenceMissing"),
        referenceUnavailable: text("propertyReferenceUnavailable"),
        picture: text("picturePreview"), pictureLoading: text("pictureLoading"), pictureMissing: text("pictureMissing"),
        pictureUnsupported: text("pictureUnsupported"), pictureInvalid: text("pictureInvalid"),
        pictureTooLarge: text("pictureTooLarge"), pictureUnavailable: text("pictureUnavailable"),
      },
      properties: this.choices.map(({ index, label, key, caption, qualifiers, value, description, presentation }) =>
        ({ index, label, key, ...(caption ? { caption } : {}), qualifiers, value, description, ...(presentation ? { presentation } : {}) })),
    };
  }

  /** Reuse the packaged tree artwork; workspace data never supplies resource URLs. */
  private icons(): Record<string, Record<string, string>> {
    const kinds = new Set(presentedItems(this.choices).map(item => item.metadataKind));
    return Object.fromEntries(Object.entries(metadataIcons).filter(([kind]) => kinds.has(kind)).map(([kind, name]) => [kind,
      Object.fromEntries(["light", "dark", "contrast", "contrast-light"].map(theme => [theme,
        this.panel.webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, "resources", "icons", theme, `${name}.svg`)).toString()]))]));
  }

  /** Package local CSS/JS with a strict CSP; workspace text reaches the DOM only via textContent. */
  private html(): string {
    const webview = this.panel.webview;
    const css = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, "resources", "properties", "view.css"));
    const script = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, "resources", "properties", "view.js"));
    const lang = vscode.env.language.toLowerCase().startsWith("ru") ? "ru" : "en";
    return `<!doctype html><html lang="${lang}"><head><meta charset="utf-8">
      <meta name="viewport" content="width=device-width, initial-scale=1">
      <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data: ${webview.cspSource}; style-src ${webview.cspSource}; script-src ${webview.cspSource};">
      <link rel="stylesheet" href="${css}"><title>ESKA Properties</title></head>
      <body><main class="page"><header class="heading"><div id="breadcrumb" class="breadcrumb"></div>
      <div class="title-row"><h1 id="title"></h1><button id="read-only" class="badge lock-button" type="button"></button><button id="undo" class="history-button" type="button" hidden></button><button id="redo" class="history-button" type="button" hidden></button></div></header>
      <div class="toolbar"><label class="visually-hidden" for="search"></label>
      <input id="search" type="search" autocomplete="off"><button id="refresh" type="button"></button></div>
      <figure id="picture-preview" class="picture-preview" hidden><div class="picture-frame" id="picture-frame">
      <span id="picture-status" role="status"></span></div>
      <figcaption id="picture-caption"></figcaption></figure>
      <p id="count" class="count" aria-live="polite"></p><p id="notice" class="notice" role="status"></p>
      <section id="items" class="items" aria-label="Properties"></section></main>
      <script type="module" src="${script}"></script></body></html>`;
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
    if (tab) {
      await tab.show(tree, entry);
      return;
    }
    tab = new PropertyTab(this.context, tree, entry, this.language, this.currentTree, this.openXml, (tree, entry) => this.show(tree, entry),
      () => { this.tabs.delete(key); });
    this.tabs.set(key, tab);
    await tab.load();
  }

  /** Keep open tabs but flag their data when the connection is replaced. */
  stale(): void { for (const tab of this.tabs.values()) tab.stale(); }

  /** Visible tabs refresh immediately; hidden tabs defer reads until revealed. */
  changed(tree: MetadataTree, entries: TreeEntry[] | undefined): void {
    for (const tab of this.tabs.values()) tab.changed(tree, entries);
  }

  relabel(): void { for (const tab of this.tabs.values()) tab.relabel(); }

  dispose(): void {
    for (const tab of [...this.tabs.values()]) tab.dispose();
    this.tabs.clear();
  }
}
