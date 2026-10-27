import * as vscode from "vscode";
import { dirname } from "node:path";
import { ToolFailure } from "../tooling/contracts.js";
import type { ToolingSetup } from "../tooling/setup.js";
import type { DiagnosticLog } from "../diagnostics.js";
import { ExplorerError } from "../protocol.js";
import { message, type MessageKey } from "../messages.js";
import { nativeReadOnly } from "../query/owner.js";
import { QUERY_SCHEME, type QueryTabs } from "../query/tabs.js";
import { FormattingBackend } from "./backend.js";
import { formatEdits, withFormatText } from "./protocol.js";

/** Native editing is the entire adapter: ESKA resolves policy, checks source ownership and computes edits. */
export class FormattingService {
  private readonly backend: FormattingBackend;
  private readonly subscriptions: vscode.Disposable[];
  private readonly pending = new Set<Promise<unknown>>();
  private readonly lifetime = new AbortController();
  private readonly requests = new Map<vscode.TextDocument, Set<AbortController>>();
  private disposed = false;

  constructor(version: string, private readonly tabs: QueryTabs, private readonly tooling: ToolingSetup, private readonly log: DiagnosticLog) {
    this.backend = new FormattingBackend(version, log);
    const selector: vscode.DocumentSelector = [{ scheme: "file", language: "bsl" }, { scheme: "file", language: "sdbl" }, { scheme: QUERY_SCHEME, language: "sdbl" }];
    this.subscriptions = [
      vscode.languages.registerDocumentFormattingEditProvider(selector, { provideDocumentFormattingEdits: (document, _options, token) => this.track(document, undefined, token) }),
      vscode.languages.registerDocumentRangeFormattingEditProvider(selector, { provideDocumentRangeFormattingEdits: (document, range, _options, token) => this.track(document, range, token) }),
      vscode.workspace.onWillSaveTextDocument(event => {
        if (!this.accepts(event.document) || !vscode.workspace.getConfiguration("eska.explorer", event.document.uri).get<boolean>("formatOnSave", false)) return;
        // If the editor already invokes this provider on save, a second listener would compute the same edit twice.
        if (vscode.workspace.getConfiguration("editor", event.document).get<boolean>("formatOnSave", false)) return;
        event.waitUntil(this.track(event.document));
      }),
      vscode.workspace.onDidChangeTextDocument(event => { if (event.contentChanges.length) this.cancel(event.document); }),
      vscode.workspace.onDidCloseTextDocument(document => this.cancel(document)),
      vscode.workspace.onDidChangeConfiguration(event => {
        if (event.affectsConfiguration("eska.explorer.executable") || event.affectsConfiguration("eska.explorer.formatterExecutable")) {
          for (const document of this.requests.keys()) this.cancel(document);
          void this.backend.stop().catch(error => this.report(error));
        }
      }),
    ];
  }

  /** Track every request so deactivation cannot strand a formatter child or temporary upload. */
  private track(document: vscode.TextDocument, range?: vscode.Range, token?: vscode.CancellationToken): Promise<vscode.TextEdit[]> {
    const job = this.format(document, range, token);
    this.pending.add(job);
    void job.finally(() => this.pending.delete(job));
    return job;
  }

  /** Provider scopes exclude protected-source views and unrelated languages without parsing the source. */
  private accepts(document: vscode.TextDocument): boolean {
    return ["bsl", "sdbl"].includes(document.languageId) && (document.uri.scheme === "file" || document.uri.scheme === QUERY_SCHEME && document.languageId === "sdbl");
  }

  /** Document versions and cancellation expire late results before native TextEdits can enter Undo/Redo. */
  private async format(document: vscode.TextDocument, range?: vscode.Range, token?: vscode.CancellationToken): Promise<vscode.TextEdit[]> {
    if (this.disposed || !vscode.workspace.isTrusted || !this.accepts(document) || document.isClosed || token?.isCancellationRequested) return [];
    const controller = new AbortController(), signal = AbortSignal.any([controller.signal, this.lifetime.signal]);
    const requests = this.requests.get(document) ?? new Set<AbortController>();
    requests.add(controller); this.requests.set(document, requests);
    const subscription = token?.onCancellationRequested(() => controller.abort());
    const version = document.version, text = document.getText();
    try {
      const configuration = vscode.workspace.getConfiguration("eska.explorer", document.uri);
      const configured = configuration.get<string>("formatterExecutable", "eska-fmt");
      const info = await this.tooling.ensureFormatter(signal, token !== undefined, configured);
      if (!info) return [];
      const formatter = info.path;
      const bytes = range ? { start: Buffer.byteLength(text.slice(0, document.offsetAt(range.start))), end: Buffer.byteLength(text.slice(0, document.offsetAt(range.end))) } : undefined;
      let result: unknown;
      if (document.uri.scheme === QUERY_SCHEME) result = await this.tabs.formatting(document, bytes, formatter, signal);
      else {
        const userReadOnly = await nativeReadOnly(document);
        const executable = await this.tooling.ensureProject(signal, configuration.get<string>("executable", "eska-project"));
        if (!executable) return [];
        const endpoint = await this.backend.endpoint(executable, dirname(document.uri.fsPath), vscode.env.language.toLowerCase().startsWith("ru") ? "ru-RU" : "en-US");
        result = await withFormatText(endpoint, text, input => endpoint.request("format/document", {
          ...input, source: { value: document.uri.fsPath, encoding: "utf-8" }, version: String(version), userReadOnly,
          ...(bytes ? { range: bytes } : {}), ...(formatter ? { formatter: { value: formatter, encoding: "utf-8" } } : {}),
        }, signal), signal);
      }
      if (signal.aborted || this.disposed || document.isClosed || document.version !== version) return [];
      const edits = formatEdits(result, text, version);
      if (await nativeReadOnly(document) || signal.aborted || this.disposed || document.isClosed || document.version !== version) return [];
      return edits.map(edit => vscode.TextEdit.replace(new vscode.Range(document.positionAt(edit.start), document.positionAt(edit.end)), edit.text));
    } catch (error) {
      if (!signal.aborted && !(error instanceof ExplorerError && ["cancelled", "obsolete"].includes(error.code))) this.report(error);
      return [];
    } finally {
      subscription?.dispose(); requests.delete(controller); if (!requests.size) this.requests.delete(document);
    }
  }

  /** Native changes cancel exact requests without affecting metadata or language processes. */
  private cancel(document: vscode.TextDocument): void { for (const request of this.requests.get(document) ?? []) request.abort(); }

  /** Errors describe the user's action; raw source or formatter output never enters notifications. */
  private report(error: unknown): void {
    const failure = error instanceof ExplorerError ? error : undefined, code = failure?.details?.code;
    const key: MessageKey = failure?.code === "executableMissing" || code === "missing" || code === "component_missing" ? "formatMissing"
      : failure?.code === "incompatible" || error instanceof ToolFailure && error.code === "incompatible" || code === "component_incompatible" ? "formatIncompatible"
      : code === "selection_required" ? "formatSelectionRequired"
      : code === "selection_expansion" ? "formatSelectionExpansion"
      : code === "change_control_protected" ? "formatChangeControlProtected"
      : ["source_read_only", "source_busy", "support_read_only", "support_unknown"].includes(String(code)) ? "formatReadonly"
      : ["source_conflict", "config_conflict"].includes(String(code)) ? "sourceChanged" : "formatFailed";
    this.log(JSON.stringify({ event: "formatting_rejected", code: failure?.code, domain: failure?.domain, reason: code }));
    if (!this.disposed) void vscode.window.showWarningMessage(message(vscode.env.language, key));
  }

  /** Component replacement invalidates plans and awaits the exact text-only backend. */
  async stop(): Promise<void> { for (const document of this.requests.keys()) this.cancel(document); await this.backend.stop(); await Promise.allSettled([...this.pending]); }

  /** The asynchronous deactivate hook owns cleanup; disposing registrations prevents new work. */
  async shutdown(): Promise<void> {
    this.disposed = true; this.lifetime.abort(); for (const subscription of this.subscriptions) subscription.dispose();
    await this.stop(); await this.backend.shutdown();
  }
}
