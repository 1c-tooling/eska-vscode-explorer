import * as vscode from "vscode";
import { realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { randomUUID } from "node:crypto";
import type { LanguageClient, Middleware, WorkspaceEdit as ProtocolEdit, CodeAction as ProtocolAction, Command as ProtocolCommand,
  CodeActionParams, RenameParams } from "vscode-languageclient/node";
import type { SupportController } from "../support.js";
import { message, type MessageKey } from "../messages.js";
import { isRecord } from "../protocol.js";
import type { AnalysisContext } from "./context.js";

type Reason = "readonly" | "stale" | "resource" | "invalid" | "command";
interface Origin { documents: Map<string, { document: vscode.TextDocument; version: number }>; token?: vscode.CancellationToken }
interface Target { document: vscode.TextDocument; version: number; path: string; stamp: string }
interface Prepared { edit: ProtocolEdit; targets: Target[]; valid: () => boolean }
interface PendingAction { edit: ProtocolEdit; origin: Origin; prepared: Prepared }
class Rejected extends Error { constructor(readonly reason: Reason) { super(reason); } }
const APPLY_ACTION = "eska.explorer.applyLanguageAction";

/** Guard complete LSP edits before one public text-only transaction; source policy remains owned by the backend. */
export class LanguageEdits implements vscode.Disposable {
  private readonly actions = new Map<string, PendingAction>();
  private readonly command: vscode.Disposable;
  private readonly applying = new Set<Promise<boolean>>();
  private disposed = false;

  /** Each language session owns its action handles and advertises only resource operations it can commit atomically. */
  constructor(private readonly client: LanguageClient, private readonly context: AnalysisContext,
    private readonly support: SupportController, private readonly current: () => boolean, private readonly log: (value: string) => void) {
    this.command = vscode.commands.registerCommand(APPLY_ACTION, async (id: unknown) => {
      const pending = typeof id === "string" ? this.actions.get(id) : undefined;
      if (typeof id === "string") this.actions.delete(id);
      try {
        if (!pending) throw new Rejected("stale");
        await this.recheck(pending.prepared, pending.origin);
        return await this.apply(pending.edit, pending.origin, false);
      } catch (error) { this.explain(error); return false; }
    });
    client.registerFeature({
      fillClientCapabilities(capabilities) {
        if (capabilities.workspace?.workspaceEdit) {
          capabilities.workspace.workspaceEdit.resourceOperations = [];
          capabilities.workspace.workspaceEdit.snippetEditSupport = false;
        }
      },
      initialize() {}, clear() {}, getState: () => ({ kind: "static" }),
    });
  }

  /** Keep writing routes explicit rather than overriding a converter whose internal code-action calls are closed over. */
  middleware(): Middleware {
    return {
      provideRenameEdits: async (document, position, newName, token) => {
        let origin = this.origin(token);
        try {
          const params: RenameParams = {
            textDocument: this.client.code2ProtocolConverter.asTextDocumentIdentifier(document),
            position: this.client.code2ProtocolConverter.asPosition(position), newName,
          };
          let raw = await this.client.sendRequest<ProtocolEdit | null>("textDocument/rename", params, token);
          if (!raw) return undefined;
          if (!raw.documentChanges) throw new Rejected("stale");
          let prepared = await this.prepare(raw, origin, false, true);
          if (raw.documentChanges.some(change => !("kind" in change) && change.textDocument.version === null)) {
            // The first result identifies unopened targets. Recompute once after those documents are synchronized.
            origin = this.origin(token);
            raw = await this.client.sendRequest<ProtocolEdit | null>("textDocument/rename", params, token);
            if (!raw) return undefined;
            prepared = await this.prepare(raw, origin, true);
          }
          const edit = await this.client.protocol2CodeConverter.asWorkspaceEdit(prepared.edit, token);
          await this.recheck(prepared, origin);
          this.assertPrepared(prepared, origin);
          return edit;
        } catch (error) { this.explain(error); return undefined; }
      },
      provideDocumentFormattingEdits: (document, options, token, next) => this.format(document, token, () => next(document, options, token)),
      provideDocumentRangeFormattingEdits: (document, range, options, token, next) => this.format(document, token, () => next(document, range, options, token)),
      provideOnTypeFormattingEdits: (document, position, ch, options, token, next) => this.format(document, token, () => next(document, position, ch, options, token), false),
      provideCodeActions: async (document, range, context, token) => {
        const origin = this.origin(token);
        try {
          const params: CodeActionParams = {
            textDocument: this.client.code2ProtocolConverter.asTextDocumentIdentifier(document),
            range: this.client.code2ProtocolConverter.asRange(range), context: this.client.code2ProtocolConverter.asCodeActionContextSync(context),
          };
          const raw = await this.client.sendRequest<(ProtocolAction | ProtocolCommand)[] | null>("textDocument/codeAction", params, token);
          this.assertOrigin(origin);
          const result: vscode.CodeAction[] = [];
          for (const action of raw ?? []) {
            if (typeof action.command === "string") continue;
            const { edit, command, ...presentation } = action as ProtocolAction;
            const converted = await this.client.protocol2CodeConverter.asCodeAction(presentation, token);
            this.assertOrigin(origin);
            if (command) converted.disabled = { reason: this.reasonText("command") };
            else if (edit) {
              try {
                const prepared = await this.prepare(edit, origin, false), id = randomUUID();
                if (this.actions.size >= 256) this.actions.delete(this.actions.keys().next().value!);
                this.actions.set(id, { edit: prepared.edit, prepared, origin: this.origin() });
                converted.command = { title: converted.title, command: APPLY_ACTION, arguments: [id] };
              } catch (error) { converted.disabled = { reason: this.reasonText(error instanceof Rejected ? error.reason : "invalid") }; }
            }
            result.push(converted);
          }
          return result;
        } catch (error) { this.explain(error); return []; }
      },
      workspace: {
        handleApplyEdit: async params => {
          try { return { applied: await this.apply(params.edit, this.origin(), true) }; }
          catch (error) { return { applied: false, failureReason: this.explain(error) }; }
        },
      },
    };
  }

  /** Versions of already open buffers belong to the request, not to the later response or action invocation. */
  private origin(token?: vscode.CancellationToken): Origin {
    return { documents: new Map(vscode.workspace.textDocuments.filter(document => document.uri.scheme === "file" && this.inside(document.uri.fsPath))
      .map(document => [document.uri.toString(), { document, version: document.version }])), ...(token ? { token } : {}) };
  }

  /** Late requests cannot write after a context replacement, closed buffer or unsaved change. */
  private assertOrigin(origin: Origin): void {
    if (this.disposed || !this.current() || origin.token?.isCancellationRequested
      || [...origin.documents.values()].some(({ document, version }) => document.isClosed || document.version !== version)) throw new Rejected("stale");
  }

  /** Source roots come only from the versioned metadata context. */
  private inside(path: string): boolean {
    return this.context.sources.some(source => {
      const local = relative(source.source, path);
      return local !== "" && !isAbsolute(local) && local !== ".." && !local.startsWith(`..${sep}`);
    });
  }

  /** Read-only include/exclude rules are evaluated by the editor's own public glob matcher. */
  private configuredReadonly(document: vscode.TextDocument): boolean {
    const configuration = vscode.workspace.getConfiguration("files", document.uri), folder = vscode.workspace.getWorkspaceFolder(document.uri);
    const matches = (key: string): boolean => Object.entries(configuration.get<Record<string, boolean>>(key, {})).some(([pattern, value]) => value === true
      && (vscode.languages.match({ scheme: "file", pattern }, document) > 0
        || !!folder && vscode.languages.match({ scheme: "file", pattern: new vscode.RelativePattern(folder, pattern) }, document) > 0));
    return matches("readonlyInclude") && !matches("readonlyExclude");
  }

  /** Only ordinary canonical files in the selected context may enter a text edit, including through another URI spelling. */
  private async target(value: string): Promise<Target> {
    const uri = vscode.Uri.parse(value, true);
    if (uri.scheme !== "file" || uri.query || uri.fragment || !isAbsolute(uri.fsPath)
      || vscode.Uri.file(uri.fsPath).toString() !== uri.toString() || !this.inside(uri.fsPath)
      || vscode.workspace.fs.isWritableFileSystem(uri.scheme) !== true) throw new Rejected("readonly");
    const canonical = await realpath(uri.fsPath);
    const same = process.platform === "win32" ? canonical.toLowerCase() === resolve(uri.fsPath).toLowerCase() : canonical === resolve(uri.fsPath);
    if (!same) throw new Rejected("readonly");
    const document = await vscode.workspace.openTextDocument(uri);
    if (this.configuredReadonly(document)) throw new Rejected("readonly");
    const metadata = await stat(canonical, { bigint: true });
    if (!metadata.isFile() || (metadata.mode & 0o222n) === 0n) throw new Rejected("readonly");
    return { document, version: document.version, path: canonical,
      stamp: `${metadata.dev}:${metadata.ino}:${metadata.size}:${metadata.mtimeNs}:${metadata.ctimeNs}` };
  }

  /** Validate every target and resource operation before conversion; resource mutations lack a text-only rollback contract. */
  private async prepare(raw: ProtocolEdit, origin: Origin, requireVersions: boolean, discoverRenameTargets = false): Promise<Prepared> {
    this.assertOrigin(origin);
    const edit = structuredClone(raw), entries: { uri: string; version?: number | null; edits: unknown[] }[] = [];
    if (edit.documentChanges && edit.changes) throw new Rejected("invalid");
    if (edit.documentChanges) {
      for (const change of edit.documentChanges) {
        if ("kind" in change) throw new Rejected("resource");
        entries.push({ uri: change.textDocument.uri, version: change.textDocument.version, edits: change.edits });
      }
    } else if (edit.changes) {
      for (const [uri, edits] of Object.entries(edit.changes)) entries.push({ uri, edits });
    }
    if (entries.length > 8192) throw new Rejected("invalid");
    if (!entries.length) return { edit, targets: [], valid: () => true };
    const targets: Target[] = [], seen = new Set<string>();
    for (const entry of entries) {
      if (typeof entry.uri !== "string" || !Array.isArray(entry.edits) || entry.edits.length > 100000) throw new Rejected("invalid");
      if (requireVersions && (entry.version == null || !origin.documents.has(entry.uri))) throw new Rejected("stale");
      // Only rename may discover unopened targets, and it must request a new versioned result before returning any edit.
      if (entry.version == null && !origin.documents.has(entry.uri) && !discoverRenameTargets) throw new Rejected("stale");
      const target = await this.target(entry.uri);
      this.assertOrigin(origin);
      if (seen.has(target.path)) throw new Rejected("invalid");
      seen.add(target.path);
      if (entry.version != null && (!Number.isSafeInteger(entry.version) || entry.version < 0 || target.version !== entry.version)) throw new Rejected("stale");
      this.ranges(target.document, entry.edits);
      targets.push(target);
    }
    let valid: () => boolean;
    try { valid = await this.support.languageWriteAccess(targets.map(target => target.path)); }
    catch { throw new Rejected("readonly"); }
    const prepared = { edit, targets, valid };
    await this.recheck(prepared, origin);
    return prepared;
  }

  /** Offset round-trips reject malformed or clamped ranges without parsing the language or metadata. */
  private range(document: vscode.TextDocument, edit: unknown): { start: number; end: number } {
    if (!isRecord(edit) || typeof edit.newText !== "string" || !isRecord(edit.range)) throw new Rejected("invalid");
    const offsets = [edit.range.start, edit.range.end].map(value => {
      if (!isRecord(value) || !Number.isSafeInteger(value.line) || !Number.isSafeInteger(value.character)
        || (value.line as number) < 0 || (value.character as number) < 0) throw new Rejected("invalid");
      const position = new vscode.Position(value.line as number, value.character as number), offset = document.offsetAt(position);
      if (!document.positionAt(offset).isEqual(position)) throw new Rejected("invalid");
      return offset;
    });
    if (offsets[0]! > offsets[1]!) throw new Rejected("invalid");
    return { start: offsets[0]!, end: offsets[1]! };
  }

  /** A malformed member rejects the entire edit, including overlaps which the editor cannot apply transactionally. */
  private ranges(document: vscode.TextDocument, edits: readonly unknown[]): void {
    const ranges = edits.map(edit => this.range(document, edit)).sort((left, right) => left.start - right.start || left.end - right.end);
    if (ranges.some((range, index) => index > 0 && ranges[index - 1]!.end > range.start)) throw new Rejected("invalid");
  }

  /** Finish asynchronous I/O before the final synchronous version/policy check and native apply call. */
  private async recheck(prepared: Prepared, origin: Origin): Promise<void> {
    for (const target of prepared.targets) {
      const metadata = await stat(target.path, { bigint: true });
      if (`${metadata.dev}:${metadata.ino}:${metadata.size}:${metadata.mtimeNs}:${metadata.ctimeNs}` !== target.stamp) throw new Rejected("stale");
    }
    this.assertPrepared(prepared, origin);
  }

  /** No await may separate this check from handing an edit to the editor. */
  private assertPrepared(prepared: Prepared, origin: Origin): void {
    this.assertOrigin(origin);
    if (!prepared.valid() || prepared.targets.some(target => target.document.isClosed || target.document.version !== target.version
      || this.configuredReadonly(target.document))) throw new Rejected("stale");
  }

  /** Resource edits are excluded, so the public API supplies one all-or-nothing text transaction. */
  private async apply(raw: ProtocolEdit, origin: Origin, requireVersions: boolean): Promise<boolean> {
    const prepared = await this.prepare(raw, origin, requireVersions);
    const converted = await this.client.protocol2CodeConverter.asWorkspaceEdit(prepared.edit);
    await this.recheck(prepared, origin);
    this.assertPrepared(prepared, origin);
    const applying = Promise.resolve(vscode.workspace.applyEdit(converted));
    this.applying.add(applying);
    try { return await applying; } finally { this.applying.delete(applying); }
  }

  /** Formatting edits target only the original buffer and retain its captured version across the server request. */
  private async format(document: vscode.TextDocument, token: vscode.CancellationToken,
    next: () => vscode.ProviderResult<vscode.TextEdit[]>, explain = true): Promise<vscode.TextEdit[] | undefined> {
    const origin = this.origin(token);
    try {
      const edit: ProtocolEdit = { documentChanges: [{ textDocument: { uri: document.uri.toString(), version: document.version }, edits: [] }] };
      const prepared = await this.prepare(edit, origin, false), result = await next();
      if (!result) return undefined;
      this.ranges(document, result.map(value => ({ range: value.range, newText: value.newText })));
      await this.recheck(prepared, origin);
      this.assertPrepared(prepared, origin);
      return result;
    } catch (error) { if (explain) this.explain(error); return undefined; }
  }

  /** Translate policy categories without exposing internal DTOs or file contents in user flows. */
  private reasonText(reason: Reason): string {
    const keys: Record<Reason, MessageKey> = { readonly: "languageEditReadonly", stale: "sourceChanged", resource: "languageEditResource",
      invalid: "languageEditInvalid", command: "languageEditCommand" };
    return message(vscode.env.language, keys[reason]);
  }

  /** Manual write operations get one actionable explanation; server requests also receive failureReason. */
  private explain(error: unknown): string {
    const reason = error instanceof Rejected ? error.reason : "invalid", text = this.reasonText(reason);
    this.log(JSON.stringify({ event: "language_edit_rejected", reason }));
    if (!this.disposed) void vscode.window.showWarningMessage(text);
    return text;
  }

  /** Drain dispatched native edits without letting an unresponsive editor retain the owned LSP and config lease forever. */
  async shutdown(): Promise<void> {
    this.dispose();
    if (!this.applying.size) return;
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([Promise.allSettled([...this.applying]), new Promise<void>(done => {
        timer = setTimeout(() => { this.log("language_edit_shutdown_timeout"); done(); }, 4000);
      })]);
    } finally { clearTimeout(timer); }
  }

  /** Pending UI choices cannot outlive the session which supplied their source versions. */
  dispose(): void { if (!this.disposed) { this.disposed = true; this.command.dispose(); this.actions.clear(); } }
}
