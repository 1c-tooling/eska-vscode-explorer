const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const vscode = require('vscode');

/** Wait for document synchronization instead of relying on filesystem event timing. */
async function until(predicate, reason) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  assert.fail(reason);
}

/** Verify URI scoping, dirty buffers, late replies and provider restarts with deterministic file-only providers. */
exports.run = async function () {
  const fixture = JSON.parse(process.env.ESKA_HOST_FIXTURE);
  const first = vscode.Uri.file(path.join(fixture.root, 'A[1],{x}.txt'));
  const second = vscode.Uri.file(path.join(fixture.root, 'A1,x.txt'));
  await fs.writeFile(first.fsPath, 'alpha\nbeta\n');
  await fs.writeFile(second.fsPath, 'gamma\ndelta\n');
  const selector = { scheme: 'file', language: 'plaintext' };
  const registered = [];
  let pending;
  let release;
  const full = new vscode.Range(0, 0, 1, 4);
  const diagnostic = vscode.languages.createDiagnosticCollection('source-test');
  registered.push(diagnostic, vscode.languages.registerHoverProvider(selector, {
    /** Delay one response to model a language server working across an external edit. */
    provideHover() {
      if (pending) { const started = pending; pending = undefined; started(); return new Promise(resolve => { release = resolve; }); }
      return new vscode.Hover('native hover');
    },
  }), vscode.languages.registerDocumentSymbolProvider(selector, {
    /** Include a nested symbol so the command API's hybrid symbol representation is covered. */
    provideDocumentSymbols() {
      const parent = new vscode.DocumentSymbol('parent', '', vscode.SymbolKind.Class, full, new vscode.Range(0, 0, 0, 5));
      parent.children = [new vscode.DocumentSymbol('child', '', vscode.SymbolKind.Method, new vscode.Range(1, 0, 1, 4), new vscode.Range(1, 0, 1, 4))];
      return [parent];
    },
  }));
  /** Replace the native legend to simulate an independently restarted language provider. */
  const tokens = (type) => vscode.languages.registerDocumentSemanticTokensProvider(selector, {
    provideDocumentSemanticTokens: () => new vscode.SemanticTokens(new Uint32Array([0, 0, 5, 0, 0])),
  }, new vscode.SemanticTokensLegend([type], []));
  let semantic = tokens('class');
  try {
    const firstView = await vscode.workspace.openTextDocument(first.with({ scheme: 'eska-protected' }));
    const secondView = await vscode.workspace.openTextDocument(second.with({ scheme: 'eska-protected' }));
    await vscode.window.showTextDocument(firstView, { preview: false });
    await until(async () => (await vscode.commands.executeCommand('vscode.provideDocumentSemanticTokens', firstView.uri))?.data.length,
      'literal glob characters in a protected URI match exactly');
    await until(async () => (await vscode.commands.executeCommand('vscode.provideDocumentSemanticTokens', secondView.uri))?.data.length,
      'second document has its own token registration');
    const outline = await vscode.commands.executeCommand('vscode.executeDocumentSymbolProvider', firstView.uri);
    assert.equal(outline[0].children[0].name, 'child', 'nested outline is preserved');

    const source = await vscode.workspace.openTextDocument(first);
    diagnostic.set(first, [new vscode.Diagnostic(new vscode.Range(0, 0, 0, 5), 'native error')]);
    await until(() => vscode.languages.getDiagnostics(firstView.uri).length === 1, 'native diagnostics forwarded');
    const edit = new vscode.WorkspaceEdit();
    edit.insert(first, new vscode.Position(0, 0), 'dirty ');
    assert.equal(await vscode.workspace.applyEdit(edit), true);
    await until(() => vscode.languages.getDiagnostics(firstView.uri).length === 0, 'mismatched dirty diagnostics removed');
    assert.equal(source.isDirty, true);
    assert.deepEqual(await vscode.commands.executeCommand('vscode.executeHoverProvider', firstView.uri, new vscode.Position(0, 1)), []);
    assert.equal((await vscode.commands.executeCommand('vscode.provideDocumentSemanticTokens', firstView.uri))?.data.length ?? 0, 0);
    assert.equal(firstView.getText(), 'alpha\nbeta\n');
    assert.equal(source.getText(), 'dirty alpha\nbeta\n', 'the bridge preserves unsaved source text');
    const undo = new vscode.WorkspaceEdit();
    undo.delete(first, new vscode.Range(0, 0, 0, 6));
    assert.equal(await vscode.workspace.applyEdit(undo), true);
    await source.save();

    let started;
    const ready = new Promise(resolve => { started = resolve; });
    pending = started;
    const late = vscode.commands.executeCommand('vscode.executeHoverProvider', firstView.uri, new vscode.Position(0, 1));
    await ready;
    await fs.writeFile(first.fsPath, 'changed\nbeta\n');
    await until(() => firstView.getText().startsWith('changed') && source.getText().startsWith('changed'), 'external source change');
    release(new vscode.Hover('stale hover'));
    assert.deepEqual(await late, [], 'late results from the old text are discarded');

    semantic.dispose();
    assert.equal((await vscode.commands.executeCommand('vscode.provideDocumentSemanticTokens', firstView.uri))?.data.length ?? 0, 0,
      'no stale tokens while the native provider is absent');
    semantic = tokens('function');
    await until(async () => {
      await vscode.commands.executeCommand('vscode.provideDocumentSemanticTokens', firstView.uri);
      const legend = await vscode.commands.executeCommand('vscode.provideDocumentSemanticTokensLegend', firstView.uri);
      return legend?.tokenTypes[0] === 'function';
    }, 'provider restart refreshes the legend');
    assert.equal(await fs.readFile(second.fsPath, 'utf8'), 'gamma\ndelta\n');
    await fs.writeFile(path.join(fixture.root, 'host-result.json'), JSON.stringify({ passed: true, suite: 'protected-language-guards',
      vscode: vscode.version, nestedSymbols: true, literalPaths: true, dirtyBuffer: true, staleResponse: true, providerRestart: true }));
  } finally {
    semantic.dispose();
    for (const subscription of registered) subscription.dispose();
  }
};
