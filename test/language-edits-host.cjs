const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const vscode = require("vscode");
let stage = "bootstrap";
const trace = [];

/** Poll only an observable provider/diagnostic transition with a fixed deadline. */
async function until(predicate, reason) {
  const end = Date.now() + 30000;
  while (Date.now() < end) { const result = await predicate(); if (result) return result; await new Promise(resolve => setTimeout(resolve, 50)); }
  throw new Error(typeof reason === "function" ? reason() : reason);
}

/** Restore a test buffer without writing source bytes or bypassing the editor's normal change events. */
async function replace(editor, text) {
  assert.equal(await editor.edit(edit => edit.replace(new vscode.Range(new vscode.Position(0, 0), editor.document.positionAt(editor.document.getText().length)), text)), true);
}

/** Real upstream providers use fresh project permissions; injected applyEdit payloads use the public middleware and native editor. */
async function run() {
  const fixture = JSON.parse(process.env.ESKA_HOST_FIXTURE), { LANGUAGE_TEXT } = await import("./language-fixture.mjs");
  assert.equal(process.env.ESKA_HOST_LANGUAGE_EDITS, "1");
  const explorer = await vscode.extensions.all.find(value => value.packageJSON.name === "eska-explorer").activate();
  const originalLog = explorer.language.log;
  explorer.language.log = (...args) => { if (trace.length < 80) trace.push(args[0]); originalLog(...args); };
  assert.equal(explorer.support.enabled, true, "source policy is enabled for this acceptance");
  await until(() => explorer.connection.state.kind === "ready", () => `metadata ready: ${JSON.stringify(explorer.connection.state)}`);
  const file = path.join(fixture.source, "CommonModules", "Обмен", "Ext", "Module.bsl"), uri = vscode.Uri.file(file);
  const sourceBytes = await fs.readFile(file), xmlBytes = await fs.readFile(fixture.descriptor);
  const document = await vscode.workspace.openTextDocument(uri), editor = await vscode.window.showTextDocument(document);
  const xml = await vscode.workspace.openTextDocument(vscode.Uri.file(fixture.descriptor)), xmlBefore = xml.getText();
  await until(() => explorer.tooling.states.analyzer.phase === "ready", "real LSP ready");
  const allowed = await explorer.support.languageWriteAccess([file]); assert.equal(allowed(), true);
  await assert.rejects(explorer.support.languageWriteAccess([fixture.descriptor]), "shared XML has a real locked attribute");
  const client = explorer.language.session.client, apply = client.clientOptions.middleware.workspace.handleApplyEdit;
  const originalRequest = client.sendRequest.bind(client);
  client.sendRequest = async (...args) => {
    try {
      const result = await originalRequest(...args);
      if (args[0] === "textDocument/codeAction" && trace.length < 80) trace.push({ code_action_result: result?.map(value => ({ title: value.title, edit: !!value.edit })) });
      return result;
    } catch (error) { if (trace.length < 80) trace.push({ request: String(args[0]?.method ?? args[0]), error: String(error), code: error.code }); throw error; }
  };
  stage = "server-edit-payloads";
  const change = (doc, text = "// injected\n", version = doc.version, target = doc.uri.toString()) => ({ textDocument: { uri: target, version },
    edits: [{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } }, newText: text }] });
  const original = document.getText();
  assert.equal((await apply({ edit: { documentChanges: [change(document), change(xml)] } })).applied, false);
  assert.equal(document.getText(), original); assert.equal(xml.getText(), xmlBefore);
  assert.equal((await apply({ edit: { documentChanges: [change(document), change(document, "x", document.version, uri.with({ scheme: "eska-protected" }).toString())] } })).applied, false);
  assert.equal((await apply({ edit: { documentChanges: [change(document, "x", document.version - 1)] } })).applied, false);
  assert.equal((await apply({ edit: { changes: { [uri.toString()]: change(document).edits } } })).applied, false);
  const created = vscode.Uri.file(path.join(fixture.source, "new.bsl"));
  assert.equal((await apply({ edit: { documentChanges: [change(document), { kind: "create", uri: created.toString() }] } })).applied, false);
  await assert.rejects(fs.access(created.fsPath)); assert.equal(document.getText(), original);
  assert.equal((await apply({ edit: { documentChanges: [change(document)] } })).applied, true);
  assert.ok(document.getText().startsWith("// injected\n"));
  await replace(editor, LANGUAGE_TEXT);

  stage = "rename";
  const rename = await until(async () => {
    const value = await vscode.commands.executeCommand("vscode.executeDocumentRenameProvider", uri, new vscode.Position(5, 15), "НоваяПроверка");
    return value?.size && value;
  }, () => `real rename result, editor version ${document.version}`);
  assert.equal(await vscode.workspace.applyEdit(rename), true);
  assert.match(document.getText(), /Функция НоваяПроверка\(/);
  assert.match(document.getText(), /= НоваяПроверка\(/);
  stage = "formatting";
  await replace(editor, LANGUAGE_TEXT.replace("    Возврат", "Возврат"));
  const formatting = await until(async () => {
    const values = await vscode.commands.executeCommand("vscode.executeFormatDocumentProvider", uri, { tabSize: 4, insertSpaces: true });
    return values?.length && values;
  }, "real formatter returns indentation edits");
  const formatted = new vscode.WorkspaceEdit(); formatted.set(uri, formatting);
  assert.equal(await vscode.workspace.applyEdit(formatted), true);
  assert.match(document.lineAt(2).text, /^\s+Возврат/);

  stage = "quick-fix-diagnostic";
  await replace(editor, LANGUAGE_TEXT.replace("// ", "//"));
  const code = value => typeof value.code === "object" ? value.code.value : value.code;
  await until(() => vscode.languages.getDiagnostics(uri).some(value => code(value) === "SpaceAtStartComment"), "real quick-fix diagnostic");
  stage = "quick-fix-provider";
  let seenActions;
  /** Resolve a real published-server fix after its diagnostic is visible. */
  const quickFixes = () => until(async () => {
    const values = await vscode.commands.executeCommand("vscode.executeCodeActionProvider", uri, new vscode.Range(0, 0, 0, document.lineAt(0).text.length), "quickfix");
    seenActions = values?.map(value => ({ title: value.title, command: value.command, disabled: value.disabled, codes: value.diagnostics?.map(code) }));
    // The public command returns presentation/command but deliberately omits attached diagnostics.
    const candidates = values?.filter(value => value.command?.command === "eska.explorer.applyLanguageAction" && value.title === "Добавить пробел после //");
    return candidates?.length && candidates;
  }, () => `guarded real quick fix: ${JSON.stringify(seenActions)}`);
  let actions = await quickFixes();
  assert.ok(actions.length);
  stage = "late-quick-fix";
  await replace(editor, document.getText() + "\n");
  const changed = document.getText();
  assert.equal(await vscode.commands.executeCommand(actions[0].command.command, ...actions[0].command.arguments), false);
  assert.equal(document.getText(), changed);
  actions = await quickFixes();
  stage = "quick-fix-apply";
  assert.equal(await vscode.commands.executeCommand(actions[0].command.command, ...actions[0].command.arguments), true);
  assert.match(document.lineAt(0).text, /^\/\/ /);

  stage = "voluntary-readonly";
  const settings = vscode.workspace.getConfiguration("files", uri), baseline = settings.get("readonlyInclude", {});
  await settings.update("readonlyInclude", { ...baseline, "**/*.bsl": true }, vscode.ConfigurationTarget.Workspace);
  const priorTrace = trace.length;
  let denied;
  try { denied = await vscode.commands.executeCommand("vscode.executeDocumentRenameProvider", uri, new vscode.Position(5, 15), "ЗапрещённоеИмя"); }
  catch (error) { assert.equal(error.message, "No result.", "the public rename command rejects an empty provider result"); }
  assert.ok(!denied?.size); assert.ok(!document.getText().includes("ЗапрещённоеИмя"));
  assert.ok(trace.slice(priorTrace).some(value => typeof value === "string" && value.includes('"reason":"readonly"')));
  assert.equal(vscode.workspace.getConfiguration("files", uri).get("readonlyInclude")["**/*.bsl"], true);
  await settings.update("readonlyInclude", baseline, vscode.ConfigurationTarget.Workspace);
  assert.deepEqual(await fs.readFile(file), sourceBytes); assert.deepEqual(await fs.readFile(fixture.descriptor), xmlBytes);
  await fs.writeFile(path.join(fixture.root, "host-result.json"), JSON.stringify({ passed: true, suite: "language-edits", vscode: vscode.version,
    real_backend_policy: true, mixed_xml_atomic_rejection: true, protected_uri_rejected: true, stale_version_rejected: true,
    unversioned_server_edit_rejected: true, resource_edit_rejected: true, versioned_server_text_edit_applied: true,
    server_apply_payloads: "injected through public middleware; native editor transaction", rename: true, formatter_edits: formatting.length,
    code_action: true, late_code_action_rejected: true, user_readonly_preserved: true, disk_unchanged: true,
    shutdownPids: [explorer.language.session.owner.child.pid, explorer.connection.child.pid] }));
}

/** Retain the actual failure before the disposable host exits and the runner removes its files. */
exports.run = async function () {
  try { await run(); }
  catch (error) {
    const fixture = JSON.parse(process.env.ESKA_HOST_FIXTURE);
    await fs.writeFile(path.join(fixture.root, "host-result.json"), JSON.stringify({ passed: false, error: `${stage}: ${String(error.stack ?? error)}\n${JSON.stringify(trace)}` }));
  }
};
