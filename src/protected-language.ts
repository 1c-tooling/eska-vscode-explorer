import * as vscode from "vscode";
import { PROTECTED_SOURCE_SCHEME, ProtectedSources } from "./protected-source.js";
import { readonlyPattern } from "./support-settings.js";

interface ProtectedDocument {
  readonly view: vscode.TextDocument;
  readonly changed: vscode.EventEmitter<void>;
  source?: vscode.TextDocument;
  ready: Promise<void>;
  semantic?: vscode.Disposable;
  legend?: string;
}

/** Reuse installed language providers on the native URI, keeping the visible editor immutable. */
export class ProtectedLanguageFeatures implements vscode.Disposable {
  private readonly documents = new Map<string, ProtectedDocument>();
  private readonly diagnostics = vscode.languages.createDiagnosticCollection("eska-protected");
  private readonly subscriptions: vscode.Disposable[] = [];
  private disposed = false;

  /** Register reading features only; edits and executable code actions never cross the bridge. */
  constructor(private readonly log: (error: unknown) => void) {
    const selector = { scheme: PROTECTED_SOURCE_SCHEME };
    this.subscriptions.push(
      vscode.languages.registerHoverProvider(selector, {
        provideHover: async (document, position, token) => {
          const values = await this.request<vscode.Hover[]>(document, token, "vscode.executeHoverProvider", position);
          return values?.length ? new vscode.Hover(values.flatMap(value => value.contents), values[0]?.range) : undefined;
        },
      }),
      vscode.languages.registerDocumentSymbolProvider(selector, {
        provideDocumentSymbols: async (document, token) => {
          const symbols = await this.request<(vscode.DocumentSymbol | vscode.SymbolInformation)[]>(document, token,
            "vscode.executeDocumentSymbolProvider");
          return symbols?.map(documentSymbol);
        },
      }),
      vscode.languages.registerDefinitionProvider(selector, {
        provideDefinition: (document, position, token) => this.definitions(document, position, token, "vscode.executeDefinitionProvider"),
      }),
      vscode.languages.registerDeclarationProvider(selector, {
        provideDeclaration: (document, position, token) => this.definitions(document, position, token, "vscode.executeDeclarationProvider"),
      }),
      vscode.languages.registerTypeDefinitionProvider(selector, {
        provideTypeDefinition: (document, position, token) => this.definitions(document, position, token, "vscode.executeTypeDefinitionProvider"),
      }),
      vscode.languages.registerImplementationProvider(selector, {
        provideImplementation: (document, position, token) => this.definitions(document, position, token, "vscode.executeImplementationProvider"),
      }),
      vscode.languages.registerReferenceProvider(selector, {
        provideReferences: async (document, position, _context, token) =>
          (await this.request<vscode.Location[]>(document, token, "vscode.executeReferenceProvider", position))
            ?.map(location => this.location(document, location)),
      }),
      vscode.languages.registerDocumentHighlightProvider(selector, {
        provideDocumentHighlights: (document, position, token) =>
          this.request<vscode.DocumentHighlight[]>(document, token, "vscode.executeDocumentHighlights", position),
      }),
      vscode.languages.registerFoldingRangeProvider(selector, {
        provideFoldingRanges: (document, _context, token) =>
          this.request<vscode.FoldingRange[]>(document, token, "vscode.executeFoldingRangeProvider"),
      }),
      vscode.languages.registerSelectionRangeProvider(selector, {
        provideSelectionRanges: (document, positions, token) =>
          this.request<vscode.SelectionRange[]>(document, token, "vscode.executeSelectionRangeProvider", positions),
      }),
      vscode.workspace.onDidOpenTextDocument(document => this.open(document)),
      vscode.workspace.onDidCloseTextDocument(document => this.close(document)),
      vscode.workspace.onDidChangeTextDocument(({ document }) => this.refresh(document.uri)),
      vscode.languages.onDidChangeDiagnostics(({ uris }) => {
        for (const uri of uris) if (uri.scheme === "file") this.refresh(uri);
      }),
      vscode.extensions.onDidChange(() => {
        for (const state of this.documents.values()) void this.prepare(state).catch(this.log);
      }),
    );
    for (const document of vscode.workspace.textDocuments) this.open(document);
  }

  /** Load only native counterparts of protected documents, never scan the project. */
  private open(view: vscode.TextDocument): void {
    if (this.disposed || view.isClosed || view.uri.scheme !== PROTECTED_SOURCE_SCHEME || this.documents.has(view.uri.toString())) return;
    const state: ProtectedDocument = { view, changed: new vscode.EventEmitter<void>(), ready: Promise.resolve() };
    this.documents.set(view.uri.toString(), state);
    state.ready = this.prepare(state).catch(this.log);
  }

  /** Wait for language activation off the editor-opening path, preserving the user's chosen extension. */
  private async prepare(state: ProtectedDocument): Promise<void> {
    const source = await this.source(state);
    if (!source) return;
    const language = source.languageId;
    const activations = await Promise.allSettled(vscode.extensions.all.filter(extension => {
      const manifest = extension.packageJSON;
      return manifest.contributes?.languages?.some((value: { id: string }) => value.id === language)
        || manifest.activationEvents?.includes(`onLanguage:${language}`);
    }).map(extension => extension.activate()));
    for (const activation of activations) if (activation.status === "rejected") this.log(activation.reason);
    if (!this.current(state)) return;
    if (state.view.languageId !== language) {
      // Language changes close and reopen the document; the open listener owns the new state.
      await vscode.languages.setTextDocumentLanguage(state.view, language);
      return;
    }
    await this.semantic(state);
    this.publishDiagnostics(state);
  }

  /** Hidden native documents may be released by VS Code; reopen without creating a writable tab. */
  private async source(state: ProtectedDocument): Promise<vscode.TextDocument | undefined> {
    if (!this.current(state)) return undefined;
    if (!state.source || state.source.isClosed) state.source = await vscode.workspace.openTextDocument(ProtectedSources.sourceUri(state.view.uri));
    return this.current(state) ? state.source : undefined;
  }

  /** Reject late responses and mismatched dirty buffers instead of mapping incorrect offsets. */
  private async request<T>(view: vscode.TextDocument, token: vscode.CancellationToken | undefined,
    command: string, ...args: unknown[]): Promise<T | undefined> {
    const version = view.version;
    this.open(view);
    const state = this.documents.get(view.uri.toString());
    if (!state || token?.isCancellationRequested) return undefined;
    await state.ready;
    const source = await this.source(state);
    if (!source || view.version !== version || !this.matches(state) || token?.isCancellationRequested) return undefined;
    const sourceVersion = source.version;
    const result = await vscode.commands.executeCommand<T>(command, source.uri, ...args);
    return this.current(state) && !token?.isCancellationRequested && view.version === version
      && source.version === sourceVersion && this.matches(state) ? result : undefined;
  }

  /** Register the source provider's exact legend, including its custom token types and modifiers. */
  private async semantic(state: ProtectedDocument): Promise<void> {
    const source = await this.source(state);
    if (!source) return;
    const legend = await vscode.commands.executeCommand<vscode.SemanticTokensLegend | undefined>(
      "vscode.provideDocumentSemanticTokensLegend", source.uri);
    // Keep the registration through a temporary provider outage, so refresh events can recover it.
    if (!this.current(state) || !legend) return;
    const key = JSON.stringify(legend);
    if (state.legend === key) return;
    state.semantic?.dispose();
    delete state.semantic;
    state.legend = key;
    const selector = { scheme: PROTECTED_SOURCE_SCHEME, pattern: readonlyPattern(state.view.uri.fsPath) };
    state.semantic = vscode.languages.registerDocumentSemanticTokensProvider(selector, {
      onDidChangeSemanticTokens: state.changed.event,
      provideDocumentSemanticTokens: async (document, token) => {
        // Recheck the legend after a provider restart; token indices must never use an old legend.
        await this.semantic(state);
        if (state.legend !== key) return undefined;
        const tokens = await this.request<vscode.SemanticTokens>(document, token, "vscode.provideDocumentSemanticTokens");
        await this.semantic(state);
        return state.legend === key ? tokens : undefined;
      },
    }, legend);
  }

  /** Map local navigation back into this readonly editor; other files keep their normal policy checks. */
  private uri(document: vscode.TextDocument, uri: vscode.Uri): vscode.Uri {
    return uri.toString() === ProtectedSources.sourceUri(document.uri).toString() ? document.uri : uri;
  }

  /** Preserve ranges verbatim because native and protected documents must contain identical text. */
  private location(document: vscode.TextDocument, location: vscode.Location): vscode.Location {
    return new vscode.Location(this.uri(document, location.uri), location.range);
  }

  /** Normalize both definition representations into links, retaining origin selections. */
  private async definitions(document: vscode.TextDocument, position: vscode.Position,
    token: vscode.CancellationToken, command: string): Promise<vscode.LocationLink[] | undefined> {
    const locations = await this.request<(vscode.Location | vscode.LocationLink)[]>(document, token, command, position);
    return locations?.map(location => "targetUri" in location
      ? { ...location, targetUri: this.uri(document, location.targetUri) }
      : { targetUri: this.uri(document, location.uri), targetRange: location.range, targetSelectionRange: location.range });
  }

  /** Relay diagnostics and invalidate highlighting when either view catches up with a disk change. */
  private refresh(uri: vscode.Uri): void {
    const view = uri.scheme === "file" ? ProtectedSources.protectedUri(uri) : uri;
    const state = this.documents.get(view.toString());
    if (!state) return;
    this.publishDiagnostics(state);
    // Some extensions register providers after activate() returns. Diagnostics mark their readiness.
    if (!state.semantic) void this.semantic(state).catch(this.log);
    state.changed.fire();
  }

  /** Do not publish analysis of unsaved source text over a different readonly disk snapshot. */
  private publishDiagnostics(state: ProtectedDocument): void {
    if (!this.current(state)) return;
    const diagnostics = this.matches(state) && state.source ? vscode.languages.getDiagnostics(state.source.uri) : [];
    this.diagnostics.set(state.view.uri, diagnostics);
  }

  /** A close or a language change invalidates in-flight work for the previous document instance. */
  private current(state: ProtectedDocument): boolean {
    return !this.disposed && !state.view.isClosed && this.documents.get(state.view.uri.toString()) === state;
  }

  /** Exact text equality also protects against independently dirty native buffers. */
  private matches(state: ProtectedDocument): boolean {
    return this.current(state) && !!state.source && !state.source.isClosed && state.source.getText() === state.view.getText();
  }

  /** Release registrations with their protected document; native documents belong to VS Code. */
  private close(document: vscode.TextDocument): void {
    const state = this.documents.get(document.uri.toString());
    if (state?.view !== document) return;
    this.documents.delete(document.uri.toString());
    state.semantic?.dispose();
    state.changed.dispose();
    this.diagnostics.delete(document.uri);
  }

  /** Stop event forwarding before disposing diagnostic and semantic registrations. */
  dispose(): void {
    this.disposed = true;
    for (const subscription of this.subscriptions) subscription.dispose();
    for (const state of this.documents.values()) this.close(state.view);
    this.diagnostics.dispose();
  }
}

/** The command API returns hybrid symbols with both location and children; retain their hierarchy. */
function documentSymbol(symbol: vscode.DocumentSymbol | vscode.SymbolInformation): vscode.DocumentSymbol {
  const range = "range" in symbol ? symbol.range : symbol.location.range;
  const result = new vscode.DocumentSymbol(symbol.name, "detail" in symbol ? symbol.detail : symbol.containerName,
    symbol.kind, range, "selectionRange" in symbol ? symbol.selectionRange : range);
  if (symbol.tags) result.tags = symbol.tags;
  if ("children" in symbol) result.children = symbol.children.map(documentSymbol);
  return result;
}
