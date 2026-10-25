import * as vscode from "vscode";
import { ProtectedSources } from "../protected-source.js";

/** A modal child remembers only native presentation; ESKA continues to own its source and permissions. */
export class QueryModalParent {
  active = true;
  readonly source: vscode.Uri;

  constructor(readonly uri: vscode.Uri, private readonly column?: vscode.ViewColumn, private readonly selection?: vscode.Selection) {
    this.source = ProtectedSources.sourceUri(uri);
  }

  /** Capture the original view before replacing it with the query, including protected-source navigation. */
  static capture(editor: vscode.TextEditor): QueryModalParent {
    return new QueryModalParent(editor.document.uri, editor.viewColumn, editor.selection);
  }

  /** File and protected aliases represent the same parent; diff editors must not expose an editable side. */
  contains(uri: vscode.Uri): boolean { return ProtectedSources.sourceUri(uri).toString() === this.source.toString(); }

  /** Locate only this parent's native views, preserving unrelated tabs and groups. */
  tabs(): vscode.Tab[] {
    return vscode.window.tabGroups.all.flatMap(group => group.tabs).filter(tab => {
      const input = tab.input;
      return input instanceof vscode.TabInputText ? this.contains(input.uri)
        : input instanceof vscode.TabInputTextDiff && (this.contains(input.original) || this.contains(input.modified));
    });
  }

  /** Native close owns dirty-file decisions; cancellation leaves the parent available and never opens a child. */
  async hide(): Promise<boolean> {
    const tabs = this.tabs();
    return !tabs.length || vscode.window.tabGroups.close(tabs, true);
  }

  /** Every completed child lifecycle returns focus and selection to the original parent view. */
  async restore(): Promise<void> {
    this.active = false;
    const editor = await vscode.window.showTextDocument(this.uri, { preview: false,
      ...(this.column !== undefined ? { viewColumn: this.column } : {}), ...(this.selection ? { selection: this.selection } : {}) });
    const group = vscode.window.tabGroups.all.find(group => group.viewColumn === editor.viewColumn);
    const restored = group?.tabs.find(tab => tab.input instanceof vscode.TabInputText && tab.input.uri.toString() === this.uri.toString());
    if (restored) {
      // WorkspaceEdit can reveal the same dirty model in another group; keep its buffer and close only duplicate views.
      const duplicates = this.tabs().filter(tab => tab !== restored && tab.input instanceof vscode.TabInputText);
      if (duplicates.length) await vscode.window.tabGroups.close(duplicates, true);
    }
  }
}

/** Only an acknowledged private query may be reverted to its provider checkpoint when replacing its native views. */
export async function hideOwnedQuery(uri: vscode.Uri): Promise<void> {
  for (const group of vscode.window.tabGroups.all) for (const tab of [...group.tabs]) {
    if (!(tab.input instanceof vscode.TabInputText) || tab.input.uri.toString() !== uri.toString()) continue;
    await vscode.window.showTextDocument(uri, { viewColumn: group.viewColumn, preview: false });
    await vscode.commands.executeCommand("workbench.action.revertAndCloseActiveEditor");
  }
}
