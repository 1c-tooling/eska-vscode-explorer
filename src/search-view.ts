import * as vscode from "vscode";
import { kindLabel } from "./kind-labels.js";
import { ExplorerError } from "./protocol.js";
import { message } from "./messages.js";
import { revealHit, SearchSession, type SearchHit, type SearchSnapshot } from "./search.js";
import { type MetadataTree, type ProjectTree, type TreeEntry } from "./tree.js";

interface Pick extends vscode.QuickPickItem { hit?: SearchHit; project?: ProjectTree; identity?: string }

/** Native quick input preserves keyboard/accessibility behavior; all matching remains in eska. */
export class SearchView implements vscode.Disposable {
  private readonly picker = vscode.window.createQuickPick<Pick>();
  private readonly session: SearchSession;
  private readonly disposables: vscode.Disposable[] = [];
  private readonly navigation = new AbortController();
  private disposed = false;
  private accepting = false;
  private failure: ExplorerError | undefined;

  constructor(private readonly tree: MetadataTree, private readonly language: () => "ru-RU" | "en-US",
    private readonly reveal: (entry: TreeEntry) => Promise<void>,
    private readonly closed: () => void) {
    this.picker.title = message(vscode.env.language, "search");
    this.picker.placeholder = message(vscode.env.language, "searchPlaceholder");
    this.picker.keepScrollPosition = true;
    this.picker.buttons = [{ iconPath: new vscode.ThemeIcon("refresh"), tooltip: message(vscode.env.language, "searchRetry") }];
    this.session = new SearchSession(tree, (snapshot) => this.render(snapshot));
    this.disposables.push(this.picker.onDidChangeValue((text) => { this.failure = undefined; this.session.setText(text); }));
    this.disposables.push(this.picker.onDidTriggerButton(() => { this.failure = undefined; this.session.setText(this.picker.value); }));
    this.disposables.push(this.picker.onDidAccept(() => { void this.accept(); }));
    this.disposables.push(this.picker.onDidHide(() => this.dispose()));
    this.session.setText("");
    this.picker.show();
  }

  /** Reopening the command focuses the same query instead of starting another index/search loop. */
  show(): void { this.picker.show(); }

  /** Repaint cached results when the tree language changes, without querying or reindexing. */
  refreshLabels(): void { this.render(this.session.snapshot); }

  /** Backend matches always stay visible, including synonym-only matches absent from the item label. */
  private render(snapshot: SearchSnapshot): void {
    if (this.disposed || this.accepting) return;
    const text = (key: Parameters<typeof message>[1], ...values: string[]): string => message(vscode.env.language, key, ...values);
    const active = this.picker.activeItems[0]?.identity;
    const picks: Pick[] = [];
    if (this.failure) picks.push({ label: text(this.failure.code), alwaysShow: true });
    if (!snapshot.text) picks.push({ label: text("searchPlaceholder"), alwaysShow: true });
    for (const row of snapshot.projects) {
      const name = row.project.info.scope.kind === "member" ? row.project.info.scope.name : this.tree.connection.target?.name ?? text(row.project.info.type);
      picks.push({ label: name, kind: vscode.QuickPickItemKind.Separator });
      for (const hit of row.hits) {
        const owner = hit.ancestry.slice(0, -1).reverse().find((node) => node.kind === "object");
        const synonyms = hit.synonyms.filter((value) => value.content.toLowerCase().includes(snapshot.text.toLowerCase()));
        picks.push({ label: hit.name, description: `${kindLabel(hit.metadataKind, this.language())} · ${name}`,
          detail: [owner?.kind === "object" ? owner.objectId : "", ...synonyms.slice(0, 2).map((value) => value.content)].filter(Boolean).join(" — "),
          alwaysShow: true, hit, project: row.project, identity: JSON.stringify([row.project.key, hit.objectId]) });
      }
      if (row.error) picks.push({ label: text(row.error.code), description: name, alwaysShow: true });
      else if (row.progress) {
        const progress = row.progress;
        if (progress.state !== "ready") picks.push({ label: text(progress.failedDescriptors ? "searchIncomplete" : "searchIndexing",
          String(progress.indexedObjects), String(progress.pendingDescriptors), String(progress.failedDescriptors)), description: name, alwaysShow: true });
        else if (snapshot.text && !row.hits.length) picks.push({ label: text("searchEmpty"), description: name, alwaysShow: true });
        if (row.truncated) picks.push({ label: text("searchLimited", String(row.hits.length)), description: name, alwaysShow: true });
      }
    }
    if (snapshot.loading && !snapshot.projects.length) picks.push({ label: text("searchLoading"), alwaysShow: true });
    this.picker.busy = snapshot.loading || snapshot.projects.some((row) => row.progress?.state === "building");
    this.picker.items = picks;
    const selected = picks.find((item) => item.identity && item.identity === active) ?? picks.find((item) => item.hit);
    if (selected) this.picker.activeItems = [selected];
  }

  /** Verify a result against the current generation before moving focus out of the picker. */
  private async accept(): Promise<void> {
    const item = this.picker.selectedItems[0] ?? this.picker.activeItems[0];
    if (this.accepting || !item?.hit || !item.project || !this.picker.items.includes(item)) return;
    this.accepting = true;
    this.picker.busy = true;
    this.picker.enabled = false;
    try {
      const entry = await revealHit(this.tree, item.project, item.hit, this.navigation.signal);
      if (this.disposed) return;
      this.dispose();
      await this.reveal(entry);
    } catch (error) {
      if (!this.disposed) {
        this.failure = error instanceof ExplorerError ? error : new ExplorerError("sourceMissing");
        this.accepting = false;
        this.picker.enabled = true;
        this.render(this.session.snapshot);
      }
    }
  }

  /** Disconnect and Escape cancel outstanding reads before disposing native controls. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.navigation.abort();
    this.session.dispose();
    for (const disposable of this.disposables) disposable.dispose();
    this.picker.dispose();
    this.closed();
  }
}
