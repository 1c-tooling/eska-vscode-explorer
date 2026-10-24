import * as vscode from "vscode";
import { hideOwnedQuery, QueryModalParent } from "./modal-parent.js";

/** Read-only inspection is a native child of the query; it owns no domain edit or second query draft. */
export class NativeQueryReview {
  private phase: "opening" | "open" | "done" = "opening";

  constructor(readonly parent: QueryModalParent, readonly snapshot: vscode.Uri, readonly current: vscode.Uri | undefined,
    private readonly title: string) {}

  /** A showing review blocks activation of its query parent until its own view closes. */
  get parentLocked(): boolean { return this.phase === "open"; }

  /** Checkpoint acknowledgement belongs to the caller; hiding this virtual parent never saves a project source. */
  async open(): Promise<void> {
    await hideOwnedQuery(this.parent.uri);
    await this.reveal();
    this.phase = "open";
  }

  /** Reuse the same native diff identity instead of allocating another view on parent navigation. */
  async reveal(): Promise<void> {
    if (this.current) await vscode.commands.executeCommand("vscode.diff", this.snapshot, this.current, this.title);
    else await vscode.window.showTextDocument(this.snapshot, { preview: false });
  }

  /** Only this exact comparison or snapshot keeps the inspection child open. */
  closed(): boolean {
    return this.phase === "open" && !vscode.window.tabGroups.all.some(group => group.tabs.some(tab => {
      const input = tab.input;
      return input instanceof vscode.TabInputTextDiff ? input.original.toString() === this.snapshot.toString()
        && input.modified.toString() === this.current?.toString()
        : input instanceof vscode.TabInputText && [this.snapshot.toString(), this.current?.toString()].includes(input.uri.toString());
    }));
  }

  /** Unregister the native child before restoring its parent so focus events cannot reopen the completed review. */
  complete(): void { this.phase = "done"; }
}
