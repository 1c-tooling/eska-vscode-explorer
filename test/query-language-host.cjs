const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const vscode = require("vscode");

/** Native providers can refuse reads during indexing; each assertion has a bounded real-server deadline. */
async function until(action, label) {
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    try { const value = await action(); if (value) return value; } catch {}
    await new Promise(resolve => setTimeout(resolve, 60));
  }
  throw new Error(label);
}

/** Editor changes use the same transaction and undo model as user typing. */
async function replace(document, before, after) {
  const offset = document.getText().indexOf(before); assert.ok(offset >= 0, before);
  const edit = new vscode.WorkspaceEdit(); edit.replace(document.uri,
    new vscode.Range(document.positionAt(offset), document.positionAt(offset + before.length)), after);
  assert.equal(await vscode.workspace.applyEdit(edit), true);
}

/** Request actual native completion and retain only the expected real-server field. */
async function completion(document, prefix, label) {
  const offset = document.getText().indexOf(prefix); assert.ok(offset >= 0, prefix);
  const position = document.positionAt(offset + prefix.length);
  const items = await vscode.commands.executeCommand("vscode.executeCompletionItemProvider", document.uri, position);
  return items?.items.find(item => (typeof item.label === "string" ? item.label : item.label.label) === label);
}

/** The installed adapter shares one published LSP for unsaved query analysis and ordinary BSL. */
exports.run = async function () {
  const fixture = JSON.parse(process.env.ESKA_HOST_FIXTURE), accepted = [], errors = [];
  let explorer;
  try {
    assert.equal(vscode.env.language, process.env.ESKA_HOST_LOCALE ?? "en");
    explorer = await vscode.extensions.all.find(value => value.packageJSON.name === "eska-explorer").activate();
    await until(() => explorer.connection.state.kind === "ready" && explorer.tree && !explorer.support.loading, "metadata ready");
    const bridge = explorer.language.queryLanguage;
    const report = bridge.log.bind(bridge); bridge.log = value => { errors.push(value); report(value); };
    const disk = await fs.readFile(fixture.module);
    const owner = await vscode.workspace.openTextDocument(vscode.Uri.file(fixture.module));
    const original = owner.getText();
    const editor = await vscode.window.showTextDocument(owner, { preview: false });
    await until(() => explorer.tooling.states.analyzer.phase === "ready" && !explorer.language.session.progress.busy, "published LSP ready");
    const session = explorer.language.session, pid = session.owner.child.pid;
    const point = owner.positionAt(owner.getText().indexOf("SELECT ") + 3); editor.selection = new vscode.Selection(point, point);
    await vscode.commands.executeCommand("eska.explorer.editBslQuery");
    const draft = await until(() => vscode.window.activeTextEditor?.document.uri.scheme === "eska-query" && vscode.window.activeTextEditor.document, "query draft");
    const first = await until(() => completion(draft, "Товар.Ар", "Артикул"), "query Артикул completion");
    assert.equal(owner.getText(), original); assert.deepEqual(await fs.readFile(fixture.module), disk);
    assert.equal(session.documents.projected(owner.uri.toString()), true);
    const native = await vscode.commands.executeCommand("vscode.executeCompletionItemProvider", owner.uri, owner.positionAt(owner.getText().indexOf("Товар.Ар") + "Товар.Ар".length));
    assert.equal(native?.items.some(item => item.label === "Артикул") ?? false, false, "native owner LSP cannot use projected coordinates");
    await assert.rejects(session.client.sendRequest("textDocument/completion", { textDocument: { uri: owner.uri.toString() }, position: { line: 2, character: 22 } }), error => error.code === -32800);
    accepted.push("metadata_completion_in_unsaved_projection_without_native_or_disk_changes");
    const textEdit = first.textEdit ?? new vscode.TextEdit(first.range, first.insertText);
    const edit = new vscode.WorkspaceEdit(); edit.replace(draft.uri, textEdit.range, textEdit.newText);
    assert.equal(await vscode.workspace.applyEdit(edit), true); assert.ok(draft.getText().includes("Товар.Артикул"));
    await replace(draft, "Товар.Артикул", "Товар.Ко");
    await until(() => completion(draft, "Товар.Ко", "Код"), "changed query Код completion");
    assert.equal(session.owner.child.pid, pid); accepted.push("completion_edit_translated_by_core_and_updated_in_one_lsp_process");
    await replace(draft, "SELECT Товар.Ко", "SELECT FROM");
    await until(() => vscode.languages.getDiagnostics(draft.uri).some(value => String(value.code?.value ?? value.code).includes("QueryParseError")), "current query parse diagnostics");
    for (const diagnostic of vscode.languages.getDiagnostics(draft.uri)) assert.equal(draft.validateRange(diagnostic.range).isEqual(diagnostic.range), true);
    assert.equal(vscode.languages.getDiagnostics(owner.uri).length, 0, "projected diagnostics never appear on native owner offsets");
    await replace(draft, "SELECT FROM", "SELECT Товар.Ар");
    await until(async () => await completion(draft, "Товар.Ар", "Артикул") && !vscode.languages.getDiagnostics(draft.uri).some(value => String(value.code?.value ?? value.code).includes("QueryParseError")), "diagnostics replaced after query change");
    accepted.push("version_guarded_pull_diagnostics_change_and_clear_on_latest_draft");
    const send = session.client.sendRequest.bind(session.client);
    let held = false, release, hold = true;
    const waiting = new Promise(resolve => { release = resolve; });
    session.client.sendRequest = async (method, ...args) => {
      const value = await send(method, ...args);
      if (method === "textDocument/completion" && hold) { hold = false; held = true; await waiting; }
      return value;
    };
    const late = vscode.commands.executeCommand("vscode.executeCompletionItemProvider", draft.uri,
      draft.positionAt(draft.getText().indexOf("Товар.Ар") + "Товар.Ар".length));
    await until(() => held, "real completion response held before presentation");
    await replace(draft, "Товар.Ар", "Товар.Ко"); release();
    const obsolete = await late;
    assert.equal(obsolete?.items.some(item => item.label === "Артикул") ?? false, false, "obsolete completion cannot reach new revision");
    session.client.sendRequest = send;
    await until(() => completion(draft, "Товар.Ко", "Код"), "latest completion after old reply discarded");
    await replace(draft, "Товар.Ко", "Товар.Ар");
    accepted.push("delayed_real_completion_is_discarded_after_draft_revision_changes");
    const packageText = "SELECT Т.Артикул AS TempArticle INTO Temp FROM Catalog.Товары AS Т;\nSELECT ВТ.TempA FROM Temp AS ВТ";
    const current = draft.getText();
    await replace(draft, current, packageText);
    await until(() => completion(draft, "ВТ.TempA", "TempArticle"), "temporary table field completion in changed package");
    await replace(draft, packageText, current);
    await until(() => completion(draft, "Товар.Ар", "Артикул"), "aliases and metadata after package");
    accepted.push("temporary_table_fields_and_aliases_use_current_whole_package");
    const other = await vscode.workspace.openTextDocument(vscode.Uri.file(fixture.languageSource.other));
    await vscode.window.showTextDocument(other, { preview: false });
    await until(() => completion(other, "Товар.Ар", "Артикул"), "ordinary BSL remains available");
    accepted.push("ordinary_bsl_in_same_application_keeps_working");
    await vscode.window.showTextDocument(draft, { preview: false });
    await vscode.commands.executeCommand("eska.explorer.restartLanguage");
    await until(() => explorer.tooling.states.analyzer.phase === "ready" && explorer.language.session.owner.child.pid !== pid, "language restart");
    await until(() => completion(draft, "Товар.Ар", "Артикул"), "query after language restart");
    assert.equal(owner.getText(), original); assert.deepEqual(await fs.readFile(fixture.module), disk);
    accepted.push("language_restart_preserves_draft_and_rebinds_shared_uri");
    await replace(owner, "Other = 42", "Other = 99");
    await until(() => !explorer.language.session.documents.projected(owner.uri.toString()), "native owner mutation releases projection");
    assert.equal((await completion(draft, "Товар.Ар", "Артикул")), undefined, "changed owner pauses query analysis");
    assert.ok(draft.getText().includes("Товар.Ар"));
    await until(() => completion(owner, "Товар.Ар", "Артикул"), "native owner restored to LSP");
    assert.equal(explorer.language.session.documents.poisoned(owner.uri.toString()), true);
    accepted.push("native_owner_edit_pauses_query_and_restores_actual_native_text");
    await vscode.commands.executeCommand("eska.explorer.cancelQuery", draft.uri);
    assert.ok(owner.getText().includes("Other = 99")); assert.deepEqual(await fs.readFile(fixture.module), disk);
    accepted.push("cancel_preserves_unrelated_native_edit_and_disk");
    const otherOriginal = other.getText(), ownerBeforeRename = owner.getText(), otherDisk = await fs.readFile(fixture.languageSource.other);
    const queryPoint = other.positionAt(other.getText().indexOf("SELECT ") + 3);
    await vscode.window.showTextDocument(other, { preview: false, selection: new vscode.Range(queryPoint, queryPoint) });
    await vscode.commands.executeCommand("workbench.action.focusActiveEditorGroup");
    await until(() => vscode.window.activeTextEditor?.document === other
      && vscode.window.activeTextEditor.selection.active.isEqual(queryPoint), "second native owner selection");
    await vscode.commands.executeCommand("eska.explorer.editBslQuery");
    const secondDraft = await until(() => vscode.window.activeTextEditor?.document.uri.scheme === "eska-query"
      && vscode.window.activeTextEditor.document, "second query draft");
    await until(() => completion(secondDraft, "Товар.Ар", "Артикул"), "second owner projection is synchronized");
    await vscode.commands.executeCommand("eska.explorer.cancelQuery", secondDraft.uri);
    const live = explorer.language.session;
    await live.documents.settled(other.uri.toString());
    const wireVersion = live.documents.wireVersion(other);
    assert.ok(Number.isInteger(wireVersion)); assert.notEqual(wireVersion, other.version, "query projection advances only the LSP clock");
    const renamePoint = other.positionAt(other.getText().indexOf("Other = 42") + 2);
    const rename = await until(async () => {
      const value = await vscode.commands.executeCommand("vscode.executeDocumentRenameProvider", other.uri, renamePoint, "AfterProjection");
      return value?.size && value;
    }, "native rename after restoring a query projection");
    assert.equal(await vscode.workspace.applyEdit(rename), true);
    assert.ok(other.getText().includes("AfterProjection = 42")); assert.equal(owner.getText(), ownerBeforeRename);
    await vscode.window.showTextDocument(other, { preview: false });
    await vscode.commands.executeCommand("workbench.action.focusActiveEditorGroup");
    await vscode.commands.executeCommand("undo");
    await until(() => other.getText() === otherOriginal, "native rename undo after projection");
    assert.deepEqual(await fs.readFile(fixture.languageSource.other), otherDisk);
    accepted.push("native_rename_after_query_cancel_preserves_wire_version_guards_and_undo");
    await fs.writeFile(path.join(fixture.root, "host-result.json"), JSON.stringify({ passed: true, suite: "query-language", accepted, errors, pid, locale: vscode.env.language }));
  } catch (error) {
    await fs.writeFile(path.join(fixture.root, "host-result.json"), JSON.stringify({ passed: false, suite: "query-language", accepted, errors,
      states: explorer ? [...explorer.language.queryLanguage.states.values()] : [], error: String(error.stack ?? error) }));
    throw error;
  }
};
