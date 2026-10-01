import type * as vscode from "vscode";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { message } from "./messages.js";
import { editorRange, existingSource } from "./source.js";
import { isRecord, type WirePath } from "./protocol.js";
import type { RenamePlan } from "./metadata-rename.js";

/** Present confirmed changes and uncertain locations in a temporary editor tab before publication. */
export function reviewRename(api: typeof vscode, context: vscode.ExtensionContext, source: WirePath, plan: RenamePlan,
  language: "ru-RU" | "en-US", signal: AbortSignal): Promise<boolean> {
  const resources = api.Uri.joinPath(context.extensionUri, "resources", "rename");
  const panel = api.window.createWebviewPanel("eska.rename", message(language, "renamePreviewTitle"), api.ViewColumn.Active,
    { enableScripts: true, localResourceRoots: [resources] });
  const css = panel.webview.asWebviewUri(api.Uri.joinPath(resources, "view.css"));
  const script = panel.webview.asWebviewUri(api.Uri.joinPath(resources, "view.js"));
  panel.webview.html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${panel.webview.cspSource}; script-src ${panel.webview.cspSource}">
    <link rel="stylesheet" href="${css}"></head><body><main><h1 id="title"></h1><p id="summary"></p><p id="notice" role="status"></p>
    <div class="actions"><label><input id="reviewed" type="checkbox"><span id="review-label"></span></label><button id="apply" disabled></button><button id="cancel"></button></div>
    <section id="issues"></section><section id="moves"></section><section id="files"></section></main><script src="${script}"></script></body></html>`;
  return new Promise(resolve => {
    let settled = false;
    /** Release the tab and its listeners once; closing a preview never writes source files. */
    const finish = (accepted: boolean): void => {
      if (settled) return;
      settled = true; signal.removeEventListener("abort", aborted); resolve(accepted); panel.dispose();
    };
    /** A closed owning property tab must not leave an actionable orphan preview. */
    const aborted = (): void => finish(false);
    signal.addEventListener("abort", aborted, { once: true });
    panel.onDidDispose(() => finish(false));
    panel.webview.onDidReceiveMessage(async (input: unknown) => {
      if (settled || !isRecord(input)) return;
      if (input.type === "ready") {
        void panel.webview.postMessage({ type: "plan", plan: { ...plan, issues: plan.issues.map(issue => ({ ...issue, caption: message(language,
          issue.reason === "source_read_only" ? "renameIssueReadOnly" : issue.reason === "opaque_code_or_form" ? "renameIssueOpaque"
            : issue.reason === "bsl_destination_shadowed" ? "renameIssueShadowed" : "renameIssueUnavailable") })) }, labels: Object.fromEntries([
          "renamePreviewTitle", "renameSummary", "renameReviewed", "renameApply", "propertyCancel", "renameMoves", "renameChanges", "renameUncertain", "renameBlocked", "openXml", "renameOpenLocation",
        ].map(key => [key, message(language, key as Parameters<typeof message>[1], "{0}", "{1}", "{2}")])) });
      } else if (input.type === "cancel") finish(false);
      else if (input.type === "apply" && !plan.issues.length && (!plan.files.some(file => file.uncertain.length) || input.reviewed === true)) finish(true);
      else if (input.type === "open") {
        const file = Number.isSafeInteger(input.file) ? plan.files[Number(input.file)] : undefined;
        const occurrence = file && Number.isSafeInteger(input.index)
          ? (input.uncertain === true ? file.uncertain : file.replacements)[Number(input.index)] : undefined;
        if (!file || !occurrence) return;
        try {
          const path = await existingSource(source, { value: file.path, encoding: "utf-8" });
          const bytes = await readFile(path);
          if (createHash("sha256").update(bytes).digest("hex") !== file.snapshot) throw new Error("stale");
          const position = editorRange(bytes, occurrence.range.start, occurrence.range.end);
          const document = await api.workspace.openTextDocument(api.Uri.file(path));
          if (document.isDirty || document.getText() !== position.text) throw new Error("stale");
          if (!settled) await api.window.showTextDocument(document, { viewColumn: api.ViewColumn.Beside, preview: true,
            selection: new api.Range(document.positionAt(position.start), document.positionAt(position.end)) });
        } catch { if (!settled) void panel.webview.postMessage({ type: "error", text: message(language, "propertyConflict") }); }
      }
    });
    if (signal.aborted) finish(false);
  });
}
