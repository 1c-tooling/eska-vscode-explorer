const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const vscode = require("vscode");

/** Repeated native provider queries tolerate only startup; each observed result still has a bounded deadline. */
async function until(action, label) {
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    let timer;
    try {
      const value = await Promise.race([action(), new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error("provider deadline")), Math.max(1, deadline - Date.now()));
      })]);
      if (value) return value;
    } catch { /* A starting LSP can return ContentModified; a hung provider still consumes the same deadline. */ }
    finally { clearTimeout(timer); }
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error(typeof label === "function" ? label() : label);
}

/** Check owned PIDs without sending termination to any process. */
function exited(pid) {
  try { process.kill(pid, 0); return false; }
  catch (error) { if (error.code === "ESRCH") return true; throw error; }
}

/** The only language provider in this profile is the installed/development Explorer and its real upstream server. */
exports.run = async function () {
  const fixture = JSON.parse(process.env.ESKA_HOST_FIXTURE);
  assert.equal(process.env.ESKA_TEST_LANGUAGE, "1");
  assert.ok(fixture.languageSource, "prepare the complete source before launching the editor");
  const { file, text } = fixture.languageSource;
  const extension = vscode.extensions.all.find(value => value.packageJSON.name === "eska-explorer");
  const explorer = await extension.activate();
  await until(() => explorer.connection.state.kind === "ready", "metadata ready");
  assert.equal(explorer.language.session, undefined, "tree-only activation does not start an index");
  await assert.rejects(fs.access(path.join(fixture.root, "bsl-analyzer.toml")));
  await vscode.commands.executeCommand("workbench.action.closeSidebar");
  await until(() => !explorer.view.visible, "tree is hidden");
  const document = await vscode.workspace.openTextDocument(vscode.Uri.file(file));
  assert.equal(document.languageId, "bsl", "Explorer registers BSL without another extension");
  const editor = await vscode.window.showTextDocument(document);
  await until(() => explorer.tooling.states.analyzer.phase === "ready", "own language client ready");
  assert.equal(explorer.view.visible, false, "language startup is independent of tree visibility");
  const session = explorer.language.session, pid = session.owner.child.pid;
  const capabilities = session.client.initializeResult.capabilities;
  assert.equal(session.client.initializeResult.serverInfo.name, "bsl-analyzer");
  assert.equal(session.client.initializeResult.serverInfo.version, "0.3.2");
  const generated = await fs.readFile(path.join(fixture.root, "bsl-analyzer.toml"), "utf8");
  assert.ok(generated.startsWith("# eska-generated "));
  assert.ok(session.lease);
  const position = new vscode.Position(5, 15), uri = document.uri;
  assert.ok(vscode.languages.match(session.client.clientOptions.documentSelector, document) > 0);
  const hover = await until(async () => {
    const values = await vscode.commands.executeCommand("vscode.executeHoverProvider", uri, position);
    return values?.some(value => value.contents.some(content => (typeof content === "string" ? content : content.value).includes("Проверка"))) && values;
  }, "hover identifies the local function");
  const definitions = await until(async () => {
    const values = await vscode.commands.executeCommand("vscode.executeDefinitionProvider", uri, position);
    return values?.some(value => (value.uri ?? value.targetUri).fsPath === file && (value.range ?? value.targetSelectionRange).start.line === 1) && values;
  }, "definition points at the expected declaration");
  const symbols = await until(async () => {
    const values = await vscode.commands.executeCommand("vscode.executeDocumentSymbolProvider", uri);
    return values?.some(value => value.name === "Проверка") && values;
  }, "document symbols");
  const completion = await until(async () => {
    const value = await vscode.commands.executeCommand("vscode.executeCompletionItemProvider", uri, position);
    return value?.items?.some(item => (typeof item.label === "string" ? item.label : item.label.label) === "Проверка") && value;
  }, "completion includes the local function");
  const semantic = await until(async () => {
    const value = await vscode.commands.executeCommand("vscode.provideDocumentSemanticTokens", uri);
    return value?.data?.length > 0 && value;
  }, "semantic tokens from the actual server");
  assert.equal(document.getText(document.getWordRangeAtPosition(position)), "Проверка");
  assert.equal(vscode.window.activeTextEditor.document.uri.toString(), uri.toString(), "editable fixture stays in the source editor");
  // Await the renderer acknowledgement; assigning editor.selection only queues an RPC.
  await vscode.window.showTextDocument(document, { selection: new vscode.Range(5, 0, 5, 0), preview: false });
  await vscode.commands.executeCommand("workbench.action.focusActiveEditorGroup");
  await vscode.commands.executeCommand("editor.action.commentLine");
  await until(() => /^\s*\/\/\s*Результат/.test(document.lineAt(5).text), () => `comment command did not update BSL: ${document.getText()}`);
  assert.match(document.lineAt(5).text, /^\s*\/\/\s*Результат/);
  await vscode.commands.executeCommand("undo");
  await until(() => document.getText() === text, "native undo restores the original BSL text");
  assert.equal(document.getText(), text);
  const end = document.positionAt(document.getText().length), syntaxLine = text.split("\n").length - 1;
  const parseErrors = () => vscode.languages.getDiagnostics(uri).filter(value => {
    const code = typeof value.code === "object" ? value.code.value : value.code;
    return code === "ParseError" && value.range.start.line >= syntaxLine;
  });
  assert.equal(await editor.edit(edit => edit.insert(end, "Функция Сломано(\n")), true);
  assert.equal(document.isDirty, true);
  await until(() => parseErrors().length > 0, "unsaved syntax error reaches VS Code");
  const broken = parseErrors().length;
  assert.equal(await editor.edit(edit => edit.replace(new vscode.Range(new vscode.Position(0, 0), document.positionAt(document.getText().length)), text)), true);
  await until(() => parseErrors().length === 0, "repaired buffer clears syntax errors");
  assert.equal(await fs.readFile(file, "utf8"), text, "unsaved language probes do not change disk bytes");
  await explorer.language.stop();
  assert.equal(exited(pid), true);
  assert.equal(explorer.connection.state.kind, "ready", "language shutdown leaves metadata running");
  assert.ok((await explorer.getChildren()).some(entry => entry.node));
  await until(() => vscode.languages.getDiagnostics(uri).filter(value => value.source === "bsl-analyzer").length === 0, "owned diagnostics cleared on stop");
  await vscode.commands.executeCommand("eska.explorer.restartLanguage");
  await until(() => explorer.tooling.states.analyzer.phase === "ready", "manual restart");
  const nextPid = explorer.language.session.owner.child.pid;
  assert.notEqual(nextPid, pid);
  await explorer.language.stop();
  assert.equal(exited(nextPid), true);
  // Leave both owned peers alive so the runner checks real extension deactivation, not only explicit stop.
  await vscode.commands.executeCommand("eska.explorer.restartLanguage");
  await until(() => explorer.tooling.states.analyzer.phase === "ready", "live client before host shutdown");
  const shutdownPid = explorer.language.session.owner.child.pid, metadataPid = explorer.connection.child.pid;
  assert.equal(exited(shutdownPid), false);
  assert.equal(exited(metadataPid), false);
  await fs.writeFile(path.join(fixture.root, "host-result.json"), JSON.stringify({ passed: true, suite: "own-language",
    vscode: vscode.version, node: process.versions.node, capabilities,
    hover: hover.length, definitions: definitions.length, symbols: symbols.length, completions: completion.items.length,
    semantic_integers: semantic.data.length, broken_syntax_errors: broken, repaired_syntax_errors: parseErrors().length,
    disk_unchanged: true, live_on_host_shutdown: true, shutdownPids: [pid, nextPid, shutdownPid, metadataPid] }));
};
