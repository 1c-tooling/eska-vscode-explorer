import * as vscode from "vscode";
import { ExplorerError } from "../protocol.js";
import { querySnapshot } from "./client.js";
import type { QuerySourceSession } from "./sessions.js";
import type { QueryConstructor } from "./constructors.js";

interface Binding {
  current(): boolean;
  header(): void;
  complete(document: vscode.TextDocument): Promise<void>;
  failed(): void;
}

/** This native transaction supplies only editor lifecycle, versions and Undo/Redo to ESKA's constructor. */
export class NativeQueryConstructor {
  private backend: QueryConstructor | undefined;
  private phase: "opening" | "design" | "reverting" | "applying" | "restoring" | "done" = "opening";
  private conflicted = false;
  private invalid = false;
  private latest: vscode.TextDocument;
  private ending: Promise<void> | undefined;
  readonly before: string;
  private readonly version: number;

  constructor(readonly source: QuerySourceSession, private readonly original: vscode.TextDocument, private readonly binding: Binding) {
    this.before = canonical(original.getText()); this.version = original.version; this.latest = original;
  }

  /** The panel receives only ESKA's model and operation SDK. */
  get core(): QueryConstructor { if (!this.backend) throw new ExplorerError("obsolete"); return this.backend; }

  /** A stopped source connection cannot lend its old constructor to a replacement process. */
  get current(): boolean { return !this.invalid && !this.conflicted && this.phase !== "done" && this.binding.current(); }

  /** Only the owned application/restoration transaction exposes its native draft model as writable. */
  get nativeWritable(): boolean {
    return this.phase === "applying" ? this.backend?.model.writable === true
      : this.phase === "restoring" && this.source.header.draftWritable;
  }

  /** Native input never checkpoints behind ESKA's lock; unexpected input is retained for explicit cancellation. */
  observe(document: vscode.TextDocument): void {
    if (this.phase === "reverting") return;
    this.latest = document;
    if (this.phase !== "applying" && this.phase !== "restoring") this.conflicted = true;
  }

  /** Scope changes invalidate callbacks synchronously, before awaited backend cleanup. */
  invalidate(): void { this.invalid = true; }

  /** The canonical checkpoint is acknowledged before replacing all editable splits by a visual panel. */
  async open(): Promise<void> {
    try { this.backend = await this.source.openConstructor(); }
    catch (error) { this.binding.failed(); throw error; }
    this.binding.header();
    if (!this.current || this.original.isClosed || this.original.version !== this.version) throw new ExplorerError("sourceChanged");
    this.phase = "reverting";
    try {
      const groups = vscode.window.tabGroups.all;
      for (const group of groups) for (const tab of [...group.tabs]) {
        if (!(tab.input instanceof vscode.TabInputText) || tab.input.uri.toString() !== this.original.uri.toString()) continue;
        await vscode.window.showTextDocument(this.original.uri, { viewColumn: group.viewColumn, preview: false });
        // This is an owned virtual draft whose exact text was checkpointed; no source Save is invoked.
        await vscode.commands.executeCommand("workbench.action.revertAndCloseActiveEditor");
      }
    } finally { this.phase = "design"; }
    if (!this.current || vscode.window.tabGroups.all.some(group => group.tabs.some(tab => tab.input instanceof vscode.TabInputText
      && tab.input.uri.toString() === this.original.uri.toString()))) throw new ExplorerError("sourceChanged");
  }

  /** Plan, one native edit and a checked receipt update the same SDBL draft; its module/XML is never touched here. */
  async finish(): Promise<void> {
    if (!this.current) throw new ExplorerError("sourceChanged");
    const baseline = querySnapshot(this.before), plan = await this.core.plan(baseline);
    if (!this.current) throw new ExplorerError("sourceChanged");
    this.phase = "applying";
    const editor = await vscode.window.showTextDocument(this.original.uri, { preview: false });
    const document = editor.document, version = document.version;
    this.latest = document;
    if (!this.current || querySnapshot(canonical(document.getText())) !== baseline) throw new ExplorerError("sourceChanged");
    if (!plan.noOp) {
      const edit = new vscode.WorkspaceEdit();
      for (const replacement of plan.replacements) edit.replace(document.uri, new vscode.Range(replacement.rangeUtf16.start.line,
        replacement.rangeUtf16.start.character, replacement.rangeUtf16.end.line, replacement.rangeUtf16.end.character), replacement.text);
      if (!await vscode.workspace.applyEdit(edit)) throw new ExplorerError("sourceChanged");
    }
    if (document.isClosed || document.version !== version + (plan.noOp ? 0 : 1)
      || querySnapshot(canonical(document.getText())) !== plan.outputSnapshot) throw new ExplorerError("sourceChanged");
    await this.core.finish(baseline, plan.outputSnapshot);
    // Input after the native edit/receipt is newer draft input and must survive the acknowledgement.
    await this.complete(document);
  }

  /** Closing the visual panel discards only its unaccepted working changes and reopens the checkpointed draft. */
  async cancel(): Promise<void> {
    if (this.phase === "done") return;
    if (this.ending) return this.ending;
    const pending = this.cancelOnce(); this.ending = pending;
    try { await pending; } finally { if (this.ending === pending) this.ending = undefined; }
  }

  /** Shutdown releases the owned token without opening another editor during window teardown. */
  async abandon(): Promise<void> {
    this.invalid = true;
    try { await this.backend?.cancel(); this.binding.header(); } catch { this.binding.failed(); }
    await this.complete(this.latest);
  }

  /** A failed release pauses this owned source handle rather than pretending the backend lock was removed. */
  private async cancelOnce(): Promise<void> {
    try { await this.backend?.cancel(); this.binding.header(); }
    catch { this.binding.failed(); }
    this.phase = "restoring";
    const editor = await vscode.window.showTextDocument(this.latest.uri, { preview: false });
    await this.complete(editor.document);
  }

  /** The provider resumes ordinary persistence only after the constructor's token has been released or its source paused. */
  private async complete(document: vscode.TextDocument): Promise<void> {
    this.phase = "done"; this.latest = document;
    await this.binding.complete(document);
  }
}

/** Private SDBL checkpoints and core plans use logical LF, independent of the native document's EOL preference. */
function canonical(text: string): string { return text.replaceAll("\r\n", "\n").replaceAll("\r", "\n"); }
