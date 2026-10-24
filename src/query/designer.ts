import * as vscode from "vscode";
import { randomBytes } from "node:crypto";
import { ExplorerError, isRecord } from "../protocol.js";
import { message, type MessageKey } from "../messages.js";
import type { ConstructorAction } from "./constructors.js";
import type { NativeQueryConstructor } from "./native-constructor.js";
import { QUERY_SCHEME, type QueryTabs } from "./tabs.js";

interface View { panel: vscode.WebviewPanel; binding: NativeQueryConstructor; busy: boolean; ending: boolean; failedApply: boolean }

/** The visual adapter renders ESKA's model and sends intentions; it contains no query parser or generator. */
export class QueryDesigner implements vscode.Disposable {
  private readonly views = new Map<string, View>();
  private readonly openings = new Map<string, Promise<void>>();
  private disposed = false;
  private readonly changes: vscode.Disposable;

  constructor(private readonly context: vscode.ExtensionContext, private readonly tabs: QueryTabs, private readonly log: (text: string) => void) {
    this.changes = tabs.onDidChangeLanguage(uri => {
      for (const [key, view] of this.views) if (!view.ending && (!uri || uri.toString() === key)) {
        void this.publish(view).catch(error => this.log(`constructor_state ${String(error)}`));
      }
    });
  }

  /** One visual panel owns one private draft; repeated commands only reveal its existing panel. */
  async show(uri = vscode.window.activeTextEditor?.document.uri): Promise<void> {
    if (!uri || uri.scheme !== QUERY_SCHEME || !uri.path.endsWith(".sdbl") || this.disposed) return;
    const existing = this.views.get(uri.toString()); if (existing) { existing.panel.reveal(); return; }
    const key = uri.toString(), opening = this.openings.get(key); if (opening) return opening;
    const pending = this.open(uri); this.openings.set(key, pending);
    try { await pending; } finally { if (this.openings.get(key) === pending) this.openings.delete(key); }
  }

  /** Concurrent toolbar commands share the same source allocation before any tab is replaced. */
  private async open(uri: vscode.Uri): Promise<void> {
    const document = await vscode.workspace.openTextDocument(uri), binding = await this.tabs.beginConstructor(document);
    if (this.disposed) { await binding.abandon(); return; }
    const roots = [vscode.Uri.joinPath(this.context.extensionUri, "resources", "query")];
    const panel = vscode.window.createWebviewPanel("eska.queryConstructor", this.text("constructorTitle"), vscode.ViewColumn.Active,
      { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: roots });
    const view: View = { panel, binding, busy: false, ending: false, failedApply: false }; this.views.set(uri.toString(), view);
    panel.webview.html = this.html(panel.webview);
    panel.webview.onDidReceiveMessage(value => { void this.receive(view, value).catch(error => this.failure(view, error)); });
    panel.onDidDispose(() => {
      this.views.delete(uri.toString());
      if (!view.ending) void binding.cancel().catch(error => this.log(`constructor_close ${String(error)}`));
    });
  }

  /** Messages can select only the binding already captured by this panel, never a source/session path. */
  private async receive(view: View, value: unknown): Promise<void> {
    if (this.disposed || view.ending || !isRecord(value)) return;
    if (value.type === "ready") { await this.publish(view); return; }
    if (view.busy) return;
    if (value.type === "cancel") {
      view.ending = true; try { await view.binding.cancel(); } finally { view.panel.dispose(); } return;
    }
    if (!view.binding.current || view.failedApply) throw new ExplorerError("sourceChanged");
    view.busy = true; await this.publish(view);
    try {
      if (value.type === "apply") {
        try { await view.binding.finish(); }
        catch (error) { view.failedApply = true; throw error; }
        view.ending = true; view.panel.dispose();
      } else if (value.type === "action" && isRecord(value.action)) {
        const action = value.action as unknown as ConstructorAction;
        try { await view.binding.core.action(action); }
        catch (error) {
          if (action.kind !== "remove" || !(error instanceof ExplorerError) || error.details?.reason !== "constructor_comments_require_decision") throw error;
          const decision = await this.commentDecision();
          if (decision) await view.binding.core.action({ ...action, comments: decision });
        }
      }
    } finally { view.busy = false; if (!view.ending) await this.publish(view); }
  }

  /** The core requests an explicit choice before deleting a commented node. */
  private async commentDecision(): Promise<"keep" | "discard" | undefined> {
    const keep = this.text("constructorKeepComments"), discard = this.text("constructorDiscardComments");
    const choice = await vscode.window.showQuickPick([keep, discard], { placeHolder: this.text("constructorCommentDecision"), ignoreFocusOut: true });
    return choice === keep ? "keep" : choice === discard ? "discard" : undefined;
  }

  /** Availability explanations are presentation; all eligibility comes from the core DTO. */
  private async publish(view: View): Promise<void> {
    const labels: Record<string, string> = {};
    for (const [name, key] of Object.entries({ apply: "constructorApply", cancel: "constructorCancel", add: "constructorAdd", edit: "constructorEdit",
      remove: "constructorRemove", up: "constructorUp", down: "constructorDown", text: "constructorText", expression: "constructorExpression", submit: "constructorSubmit",
      close: "constructorCloseInput", fields: "constructorFields", sources: "constructorSources", joins: "constructorJoins", conditions: "constructorConditions", group: "constructorGroup", order: "constructorOrder",
      statement: "constructorStatement", notice: "constructorNotice", empty: "constructorEmpty", inner: "constructorInner", left: "constructorLeft", right: "constructorRight", full: "constructorFull" })) {
      labels[name] = this.text(key as MessageKey);
    }
    const reasons = Object.fromEntries(["unsupported_statement", "unsupported_construct", "invalid_syntax", "model_limit", "read_only", "required_item", "source_required",
      "join_order_dependency", "single_item", "expression_too_large", "unsupported"].map(reason => [reason, this.reason(reason)]));
    await view.panel.webview.postMessage({ type: "model", model: view.binding.core.model, labels, reasons, maxExpression: view.binding.core.limits.maxExpression,
      busy: view.busy, paused: !view.binding.current || view.failedApply, pausedText: this.text(view.failedApply ? "constructorReceiptFailed" : "constructorChanged") });
  }

  /** Technical reasons stay in diagnostics; query text is never put into an executable error payload. */
  private async failure(view: View, error: unknown): Promise<void> {
    const reason = error instanceof ExplorerError ? String(error.details?.reason ?? "") : "";
    this.log(`constructor_error ${reason || (error instanceof ExplorerError ? error.code : "io")}`);
    const text = this.text(view.failedApply ? "constructorReceiptFailed" : error instanceof ExplorerError && error.code === "sourceChanged" ? "constructorChanged"
      : reason === "constructor_limit" ? "constructorLimit" : reason === "user_read_only" ? "queryReadonly" : "constructorInvalid");
    await view.panel.webview.postMessage({ type: "error", text });
  }

  /** A small local resource page receives all model text through postMessage and renders it with textContent. */
  private html(webview: vscode.Webview): string {
    const nonce = randomBytes(16).toString("hex"), root = vscode.Uri.joinPath(this.context.extensionUri, "resources", "query");
    const script = webview.asWebviewUri(vscode.Uri.joinPath(root, "designer.js")), style = webview.asWebviewUri(vscode.Uri.joinPath(root, "designer.css"));
    return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}'"><link rel="stylesheet" href="${style}"></head><body><main id="root"></main><script nonce="${nonce}" src="${script}"></script></body></html>`;
  }

  /** Unknown syntax and resource limits are distinct from normal read-only restrictions. */
  private reason(reason: string): string {
    const key: MessageKey = reason === "read_only" ? "queryReadonly" : ["model_limit", "expression_too_large"].includes(reason) ? "constructorLimit"
      : reason === "required_item" ? "constructorRequired" : reason === "source_required" ? "constructorSourceRequired" : reason === "single_item" ? "constructorSingle"
      : reason === "join_order_dependency" ? "constructorJoinOrder" : reason === "invalid_syntax" ? "constructorSyntax" : "constructorUnsupported";
    return this.text(key);
  }

  /** One translation function keeps all new UI strings present in both supported locales. */
  private text(key: MessageKey): string { return message(vscode.env.language, key); }

  /** Await owned tokens before metadata teardown, without opening an editor during window shutdown. */
  async shutdown(): Promise<void> {
    this.disposed = true;
    this.changes.dispose();
    await Promise.allSettled(this.openings.values());
    await Promise.allSettled([...this.views.values()].map(async view => { view.ending = true; await view.binding.abandon(); view.panel.dispose(); }));
    this.views.clear();
  }

  /** The extension's awaited shutdown owns asynchronous cleanup. */
  dispose(): void { void this.shutdown(); }
}
