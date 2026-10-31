import type * as vscode from "vscode";
import { multilineStrings, withStringText, type MultilineString, type StringEndpoint } from "./strings.js";

type Next = (document: vscode.TextDocument, range: vscode.Range, token: vscode.CancellationToken) => vscode.ProviderResult<vscode.InlayHint[]>;
interface Geometry { version: number; epoch: number; value: Promise<MultilineString[]>; controller: AbortController }
interface Display { version: number; decorations: vscode.DecorationOptions[] }
interface Advance { offset: number; text: string; margins: number }
const MAX_DECORATION_CHARACTERS = 131_072;

/** One renderer gives a multiline parameter label and every continuation exactly the same advance. */
export class InlayAlignment implements vscode.Disposable {
  private readonly styles = new Map<string, vscode.TextEditorDecorationType>();
  private readonly applied = new WeakMap<vscode.TextEditor, Map<vscode.TextEditorDecorationType, string>>();
  private readonly subscriptions: vscode.Disposable[];
  private readonly displays = new Map<vscode.TextDocument, Display>();
  private geometry = new WeakMap<vscode.TextDocument, Geometry>();
  private scope = new AbortController();
  private epoch = 0;
  private disposed = false;

  constructor(private readonly api: typeof vscode, private readonly endpoint: StringEndpoint,
    private readonly valid: () => boolean, private readonly refresh: () => void,
    private readonly resolves: (document: vscode.TextDocument) => boolean,
    private readonly contextEpoch: () => unknown = () => undefined) {
    this.subscriptions = [api.window.onDidChangeVisibleTextEditors(() => this.render()),
      api.workspace.onDidCloseTextDocument(document => {
        this.geometry.get(document)?.controller.abort(); this.geometry.delete(document); this.displays.delete(document); this.render();
      }),
      api.workspace.onDidChangeConfiguration(event => {
        if (event.affectsConfiguration("editor.inlayHints") || event.affectsConfiguration("editor.accessibilitySupport")) this.invalidate();
      })];
  }

  /** Actionable/resolved hints and calls outside multiline arguments stay with the native provider. */
  async provide(document: vscode.TextDocument, range: vscode.Range, token: vscode.CancellationToken, next: Next): Promise<vscode.InlayHint[] | undefined> {
    const epoch = this.epoch, version = document.version, context = this.contextEpoch();
    if (!this.enabled(document) || this.resolves(document)) {
      this.displays.delete(document); this.render();
      return await next(document, range, token) ?? undefined;
    }
    // Upstream already traverses this file once to infer bindings; a whole-file span also covers
    // a visible continuation whose opening quote is above the viewport.
    const full = new this.api.Range(0, 0, document.lineCount - 1, document.lineAt(document.lineCount - 1).text.length);
    const hints = await next(document, full, token);
    if (!this.current(document, version, epoch, token, context)) return undefined;
    const visible = (values: readonly vscode.InlayHint[]) => values.filter(hint => range.contains(hint.position));
    if (!hints?.some(hint => this.plain(hint))) {
      this.displays.delete(document); this.render();
      return hints ? visible(hints) : undefined;
    }
    let strings: MultilineString[];
    try { strings = await this.strings(document, version, epoch); }
    catch {
      if (!this.current(document, version, epoch, token, context)) return undefined;
      this.displays.delete(document); this.render();
      return visible(hints);
    }
    if (!this.current(document, version, epoch, token, context) || !this.enabled(document)) return undefined;
    const byLine = new Map<number, { hint: vscode.InlayHint; offset: number }[]>();
    const counts = new Map<number, number>();
    for (const hint of hints) {
      const offset = document.offsetAt(hint.position), line = byLine.get(hint.position.line) ?? [];
      line.push({ hint, offset }); byLine.set(hint.position.line, line); counts.set(offset, (counts.get(offset) ?? 0) + 1);
    }
    for (const line of byLine.values()) line.sort((one, two) => one.offset - two.offset);
    const advances = new Map<number, Advance>(), replaced = new Set<vscode.InlayHint>(), decorations: vscode.DecorationOptions[] = [];
    const padding = this.api.workspace.getConfiguration("editor", document).get<boolean>("inlayHints.padding", false);
    let characters = 0;
    for (const string of strings) {
      const position = document.positionAt(string.start);
      const prefix = (byLine.get(position.line) ?? []).filter(value => value.offset <= string.start);
      if (!prefix.some(value => value.offset === string.start) || prefix.some(value => !this.plain(value.hint) || counts.get(value.offset) !== 1)) continue;
      const previous = advances.get(position.line);
      let text = previous && previous.offset < string.start ? previous.text : "";
      let margins = previous && previous.offset < string.start ? previous.margins : 0;
      for (const { hint, offset } of prefix) {
        const label = `${hint.paddingLeft ? "\u00a0" : ""}${hint.label}${hint.paddingRight ? "\u00a0" : ""}`;
        text += label; margins++;
        if (!replaced.has(hint)) {
          decorations.push(this.attachment(document, offset, label, padding ? 1 : 0, false));
          characters += label.length; replaced.add(hint);
        }
      }
      for (const continuation of string.continuations) {
        decorations.push(this.attachment(document, continuation, text, padding ? margins : 0, true));
        advances.set(document.positionAt(continuation).line, { offset: continuation, text, margins });
        characters += text.length;
      }
      if (characters > MAX_DECORATION_CHARACTERS) {
        this.displays.delete(document); this.render(); return visible(hints);
      }
    }
    if (!this.api.window.visibleTextEditors.some(editor => editor.document === document)) return visible(hints);
    this.displays.set(document, { version, decorations }); this.render();
    return visible(hints.filter(hint => !replaced.has(hint)));
  }

  /** Any model/setting change retires source positions before it asks the native provider to refresh. */
  invalidate(): void {
    if (this.disposed) return;
    ++this.epoch; this.scope.abort(); this.scope = new AbortController();
    this.geometry = new WeakMap(); this.displays.clear(); this.render();
    this.refresh();
  }

  private strings(document: vscode.TextDocument, version: number, epoch: number): Promise<MultilineString[]> {
    const existing = this.geometry.get(document);
    if (existing?.version === version && existing.epoch === epoch) return existing.value;
    const text = document.getText(), controller = new AbortController();
    const signal = AbortSignal.any([this.scope.signal, controller.signal]);
    const value = withStringText(this.endpoint, text, input => this.endpoint.request("language/multilineStrings", { version: String(version), ...input }, signal), signal)
      .then(value => multilineStrings(value, text, version, this.endpoint.limits));
    const entry = { version, epoch, value, controller }; this.geometry.set(document, entry);
    void value.catch(() => { if (this.geometry.get(document) === entry) this.geometry.delete(document); });
    return value;
  }

  private plain(hint: vscode.InlayHint): boolean {
    return hint.kind === this.api.InlayHintKind.Parameter && typeof hint.label === "string" && hint.label.length > 0
      && hint.label.length <= 2048 && !/[\r\n\0]/.test(hint.label) && !hint.textEdits?.length && !hint.tooltip;
  }

  private current(document: vscode.TextDocument, version: number, epoch: number, token: vscode.CancellationToken, context: unknown): boolean {
    return !this.disposed && this.valid() && !document.isClosed && document.version === version && this.epoch === epoch && this.contextEpoch() === context && !token.isCancellationRequested;
  }

  private enabled(document: vscode.TextDocument): boolean {
    const settings = this.api.workspace.getConfiguration("editor", document);
    // Conditional modifier visibility has no public editor event. Its native hints stay intact.
    return !this.disposed && this.valid() && document.languageId === "bsl" && document.uri.scheme === "file"
      && settings.get<string>("inlayHints.enabled", "on") === "on" && settings.get<string>("accessibilitySupport", "auto") !== "on";
  }

  private attachment(document: vscode.TextDocument, offset: number, text: string, margins: number, invisible: boolean): vscode.DecorationOptions {
    const position = document.positionAt(offset);
    return { range: new this.api.Range(position, position), renderOptions: { before: {
      contentText: text, color: invisible ? "transparent" : new this.api.ThemeColor("editorInlayHint.parameterForeground"),
      backgroundColor: invisible ? "transparent" : new this.api.ThemeColor("editorInlayHint.parameterBackground"),
      fontStyle: "normal", fontWeight: "normal", margin: margins ? `0 ${margins * 0.125}em` : "0",
    } } };
  }

  private render(): void {
    const editors = this.api.window.visibleTextEditors.map(editor => {
      const display = this.displays.get(editor.document);
      return { editor, values: display?.version === editor.document.version && !editor.document.isClosed && this.enabled(editor.document) ? display.decorations : [] };
    });
    const needed = new Map<string, vscode.ThemableDecorationAttachmentRenderOptions>();
    for (const { values } of editors) for (const value of values) {
      const before = value.renderOptions?.before;
      if (before) needed.set(JSON.stringify(before), before);
    }
    for (const [key, style] of this.styles) if (!needed.has(key)) { style.dispose(); this.styles.delete(key); }
    for (const [key, before] of needed) if (!this.styles.has(key)) this.styles.set(key,
      this.api.window.createTextEditorDecorationType({ before, rangeBehavior: this.api.DecorationRangeBehavior.ClosedClosed }));
    for (const { editor, values } of editors) {
      const groups = new Map<string, vscode.Range[]>();
      for (const value of values) {
        const key = JSON.stringify(value.renderOptions?.before), group = groups.get(key) ?? [];
        group.push(value.range); groups.set(key, group);
      }
      const applied = this.applied.get(editor) ?? new Map<vscode.TextEditorDecorationType, string>();
      const current = new Set(this.styles.values());
      for (const style of applied.keys()) if (!current.has(style)) applied.delete(style);
      // Viewport requests share unchanged positions; do not trigger another editor layout.
      for (const [key, style] of this.styles) {
        const ranges = groups.get(key) ?? [];
        const signature = JSON.stringify(ranges.map(range => [range.start.line, range.start.character, range.end.line, range.end.character]));
        if (applied.get(style) === signature) continue;
        editor.setDecorations(style, ranges); applied.set(style, signature);
      }
      this.applied.set(editor, applied);
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true; this.scope.abort(); this.displays.clear(); this.render();
    for (const subscription of this.subscriptions) subscription.dispose();
  }
}
