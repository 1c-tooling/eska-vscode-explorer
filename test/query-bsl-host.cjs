const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const vscode = require("vscode");

/** Observe bounded native transitions without replacing the installed backend or filesystem provider. */
async function until(predicate, message) {
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 40));
  }
  throw new Error(message);
}

/** A native text transaction exercises the same editor version and Undo stack as ordinary editing. */
async function replace(document, before, after) {
  const start = document.getText().indexOf(before);
  assert.ok(start >= 0, before);
  const edit = new vscode.WorkspaceEdit();
  edit.replace(document.uri, new vscode.Range(document.positionAt(start), document.positionAt(start + before.length)), after);
  assert.equal(await vscode.workspace.applyEdit(edit), true);
}

/** Focus the actual BSL literal before invoking the public contextual command. */
async function openQuery(owner) {
  const editor = await vscode.window.showTextDocument(owner, { preview: false });
  const at = owner.positionAt(owner.getText().indexOf("SELECT ") + 3);
  editor.selection = new vscode.Selection(at, at);
  await vscode.commands.executeCommand("eska.explorer.editBslQuery");
  await until(() => vscode.window.activeTextEditor?.document.uri.scheme === "eska-query", "BSL draft opened");
  return vscode.window.activeTextEditor.document;
}

/** Close all splits of this exact URI; a clean checkpoint avoids the unrelated native unsaved-file prompt. */
async function close(document) {
  if (document.isDirty) assert.equal(await document.save(), true);
  const tabs = vscode.window.tabGroups.all.flatMap(group => group.tabs).filter(tab => tab.input instanceof vscode.TabInputText
    && tab.input.uri.toString() === document.uri.toString());
  assert.equal(await vscode.window.tabGroups.close(tabs), true);
}

/** Installed public commands enforce checkpoint-only saves, exact conflicts, undoable Apply and close decisions. */
exports.run = async function () {
  const fixture = JSON.parse(process.env.ESKA_HOST_FIXTURE);
  const errors = [], methods = [], accepted = [];
  try {
    assert.equal(vscode.env.language, process.env.ESKA_HOST_LOCALE ?? "en");
    const extension = vscode.extensions.all.find(value => value.packageJSON.name === "eska-explorer");
    const explorer = await extension.activate();
    await until(() => explorer.tree && explorer.connection.state.kind === "ready" && !explorer.support.loading, "backend ready");
    assert.equal(explorer.connection.recovery.sessions.capabilities.bslEditing, true);
    const originalFailure = explorer.queries.failure.bind(explorer.queries);
    explorer.queries.failure = error => { errors.push({ code: error?.code, domain: error?.domain, details: error?.details, message: String(error?.stack ?? error) }); originalFailure(error); };
    const peer = explorer.connection.child, request = peer.request.bind(peer);
    peer.request = (method, ...args) => { methods.push(method); return request(method, ...args); };
    const disk = await fs.readFile(fixture.module);
    const owner = await vscode.workspace.openTextDocument(vscode.Uri.file(fixture.module));
    await replace(owner, "Other = 42", "Other = 43");
    const dirty = owner.getText();
    let draft = await openQuery(owner);
    assert.equal(draft.getText(), "SELECT 1\nAS Value");
    await vscode.commands.executeCommand("workbench.action.splitEditorRight");
    await until(() => vscode.window.visibleTextEditors.filter(editor => editor.document === draft).length === 2, "split views share one Native document");
    accepted.push("split_query_tabs_share_one_draft");
    const protectedUri = owner.uri.with({ scheme: "eska-protected" });
    assert.equal(Buffer.from(await vscode.workspace.fs.readFile(protectedUri)).toString(), dirty);
    await assert.rejects(vscode.workspace.fs.writeFile(protectedUri, Buffer.from("bad")));
    accepted.push("dirty_owner_snapshot_and_provider_write_denial");
    await replace(draft, "SELECT 1", "SELECT 2");
    const preparedBefore = methods.filter(method => method === "query/sessionPrepare").length;
    assert.equal(await draft.save(), true);
    assert.equal(methods.filter(method => method === "query/sessionPrepare").length, preparedBefore);
    assert.equal(owner.getText(), dirty);
    assert.deepEqual(await fs.readFile(fixture.module), disk);
    accepted.push("save_checkpoints_without_preparing_or_applying");
    await replace(owner, "Other = 43", "Other = 44");
    const concurrent = owner.getText();
    await vscode.commands.executeCommand("eska.explorer.applyQuery", draft.uri);
    await until(() => [...explorer.queries.sessions.values()].every(session => !session.resumed && !session.source), "conflict releases only source lease");
    assert.equal(owner.getText(), concurrent);
    assert.equal(draft.getText(), "SELECT 2\nAS Value");
    assert.ok(errors.some(error => error.details?.reason === "stale_version"));
    assert.deepEqual(await fs.readFile(fixture.module), disk);
    accepted.push("ordinary_file_tabs_remain_editable_and_conflict_retains_both_texts");
    await vscode.commands.executeCommand("eska.explorer.cancelQuery", draft.uri);
    await until(() => explorer.queries.sessions.size === 0, "cancel removes exact session");
    assert.equal(owner.getText(), concurrent);
    draft = await openQuery(owner);
    await replace(draft, "SELECT 1", "SELECT 3");
    await vscode.commands.executeCommand("eska.explorer.applyQuery", draft.uri);
    await until(() => explorer.queries.sessions.size === 0, "successful Apply closes session");
    const applied = concurrent.replace("SELECT 1", "SELECT 3");
    assert.equal(owner.getText(), applied);
    assert.equal(owner.isDirty, true);
    assert.deepEqual(await fs.readFile(fixture.module), disk);
    await vscode.window.showTextDocument(owner, { preview: false });
    await vscode.commands.executeCommand("undo");
    assert.equal(owner.getText(), concurrent);
    await vscode.commands.executeCommand("redo");
    assert.equal(owner.getText(), applied);
    accepted.push("explicit_apply_preserves_other_queries_bom_crlf_dirty_text_and_single_undo_redo");
    // Only modal answer selection is stubbed; real tab closure, editor models, RPC and persistence remain active.
    const decision = explorer.queries.closeDecision;
    let choice;
    explorer.queries.closeDecision = () => Promise.resolve(choice);
    try {
      draft = await openQuery(owner);
      await replace(draft, "SELECT 3", "SELECT 4");
      const uri = draft.uri;
      await close(draft);
      await until(() => vscode.window.activeTextEditor?.document.uri.toString() === uri.toString(), "Cancel reopens the same draft");
      draft = vscode.window.activeTextEditor.document;
      assert.equal(draft.getText(), "SELECT 4\nAS Value");
      choice = "keep";
      await close(draft);
      await until(() => [...explorer.queries.sessions.values()].every(session => !session.source && !session.resumed), "Keep releases lease");
      assert.equal(explorer.queries.sessions.size, 1);
      assert.equal(owner.getText(), applied);
      await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(uri), { preview: false });
      await vscode.commands.executeCommand("eska.explorer.resumeQuery");
      choice = "discard";
      await close(vscode.window.activeTextEditor.document);
      await until(() => explorer.queries.sessions.size === 0, "Discard removes checkpoint");
      assert.equal(owner.getText(), applied);
      accepted.push("close_cancel_keep_explicit_resume_and_discard");
      draft = await openQuery(owner);
      await replace(draft, "SELECT 3", "SELECT 5");
      choice = "apply";
      await close(draft);
      await until(() => explorer.queries.sessions.size === 0, "close Apply finishes");
      assert.equal(owner.getText(), applied.replace("SELECT 3", "SELECT 5"));
      assert.deepEqual(await fs.readFile(fixture.module), disk);
      accepted.push("close_explicit_apply_never_saves_owner");
    } finally { explorer.queries.closeDecision = decision; }
    // A late real native edit after the server's prepare reply must abort its durable intent before any query replacement.
    draft = await openQuery(owner);
    await replace(draft, "SELECT 5", "SELECT 6");
    const transport = peer.request.bind(peer);
    let late = true;
    peer.request = async (method, ...args) => {
      const result = await transport(method, ...args);
      if (method === "query/sessionPrepare" && late) {
        late = false;
        await replace(owner, "Other = 44", "Other = 45");
      }
      return result;
    };
    await vscode.commands.executeCommand("eska.explorer.applyQuery", draft.uri);
    assert.equal(owner.getText().includes("SELECT 5"), true);
    assert.equal(owner.getText().includes("Other = 45"), true);
    assert.equal(draft.getText(), "SELECT 6\nAS Value");
    assert.equal([...explorer.queries.sessions.values()][0].source, undefined);
    assert.equal(explorer.queries.recovery.hasPrepared([...explorer.queries.sessions.keys()][0]), false);
    assert.ok(methods.includes("query/sessionAbort"));
    await vscode.commands.executeCommand("eska.explorer.cancelQuery", draft.uri);
    accepted.push("late_native_edit_aborts_prepared_intent_and_preserves_draft");
    // Native readonly commands belong to the user; a query session must neither reset nor force them.
    await vscode.window.showTextDocument(owner, { preview: false });
    await vscode.commands.executeCommand("workbench.action.files.setActiveEditorReadonlyInSession");
    draft = await openQuery(owner);
    await vscode.commands.executeCommand("eska.explorer.cancelQuery", draft.uri);
    await vscode.window.showTextDocument(owner, { preview: false });
    const beforeReadonlyType = owner.getText();
    await vscode.commands.executeCommand("type", { text: "blocked" });
    assert.equal(owner.getText(), beforeReadonlyType);
    await vscode.commands.executeCommand("workbench.action.files.setActiveEditorWriteableInSession");
    const files = vscode.workspace.getConfiguration("files", owner.uri);
    await files.update("readonlyInclude", { "**/ObjectModule.bsl": true }, vscode.ConfigurationTarget.Workspace);
    draft = await openQuery(owner);
    assert.equal((await vscode.workspace.fs.stat(draft.uri)).permissions, vscode.FilePermission.Readonly);
    await vscode.commands.executeCommand("eska.explorer.applyQuery", draft.uri);
    assert.ok(errors.some(error => error.details?.reason === "user_read_only"));
    await vscode.commands.executeCommand("eska.explorer.cancelQuery", draft.uri);
    await vscode.window.showTextDocument(owner, { preview: false });
    const end = owner.positionAt(owner.getText().length);
    vscode.window.activeTextEditor.selection = new vscode.Selection(end, end);
    await vscode.commands.executeCommand("type", { text: "// prior native grant\r\n" });
    assert.notEqual(owner.getText(), beforeReadonlyType);
    await files.update("readonlyInclude", undefined, vscode.ConfigurationTarget.Workspace);
    await vscode.commands.executeCommand("workbench.action.files.resetActiveEditorReadonlyInSession");
    accepted.push("prior_readonly_and_writeable_overrides_preserved_configured_restriction_refuses_apply");
    const unsupportedEditor = await vscode.window.showTextDocument(owner, { preview: false });
    const computed = owner.positionAt(owner.getText().indexOf('"SELECT " +') + 3);
    unsupportedEditor.selection = new vscode.Selection(computed, computed);
    await vscode.commands.executeCommand("eska.explorer.editBslQuery");
    assert.equal(explorer.queries.sessions.size, 0);
    assert.ok(errors.some(error => error.details?.reason === "unsupported_expression"));
    accepted.push("computed_expression_refused_without_owner_mutation");
    draft = await openQuery(owner);
    await replace(draft, "SELECT 5", "SELECT 7");
    assert.equal(await draft.save(), true);
    const queryUri = draft.uri, oldPid = explorer.connection.child.pid;
    const retained = owner.getText();
    process.kill(oldPid, "SIGKILL");
    await until(() => explorer.connection.state.kind === "error", "real backend crash observed");
    await vscode.commands.executeCommand("eska.explorer.restart");
    await until(() => explorer.connection.state.kind === "ready" && explorer.connection.child.pid !== oldPid && !explorer.support.loading,
      "fresh process connected");
    await explorer.queries.ready;
    assert.equal(owner.getText(), retained);
    assert.equal(draft.getText(), "SELECT 7\nAS Value");
    assert.equal([...explorer.queries.sessions.values()][0].resumed, false);
    await vscode.window.showTextDocument(draft, { preview: false });
    await files.update("readonlyInclude", { "**/ObjectModule.bsl": true }, vscode.ConfigurationTarget.Workspace);
    await vscode.commands.executeCommand("eska.explorer.resumeQuery");
    assert.equal([...explorer.queries.sessions.values()][0].resumed, false);
    assert.equal([...explorer.queries.sessions.values()][0].source, undefined, "failed Resume releases its own backend lease");
    assert.equal(draft.getText(), "SELECT 7\nAS Value");
    await files.update("readonlyInclude", undefined, vscode.ConfigurationTarget.Workspace);
    await vscode.commands.executeCommand("eska.explorer.resumeQuery");
    assert.equal([...explorer.queries.sessions.values()][0].resumed, true);
    await vscode.commands.executeCommand("eska.explorer.applyQuery", queryUri);
    await until(() => explorer.queries.sessions.size === 0, "recovered query applied explicitly");
    assert.equal(owner.getText(), retained.replace("SELECT 5", "SELECT 7"));
    assert.deepEqual(await fs.readFile(fixture.module), disk);
    accepted.push("real_backend_kill_retains_dirty_parent_and_checkpoint_explicit_resume_no_replay");
    assert.equal(methods.filter(method => method === "query/plan").length, 0);
    await fs.writeFile(path.join(fixture.root, "host-result.json"), JSON.stringify({ passed: true, locale: vscode.env.language, accepted, errors,
      sourceSessions: methods.filter(method => method.startsWith("query/session")) }));
    await vscode.commands.executeCommand("workbench.action.closeWindow");
  } catch (error) {
    await fs.writeFile(path.join(fixture.root, "host-result.json"), JSON.stringify({ passed: false, error: String(error.stack ?? error), accepted, errors }));
    throw error;
  }
};
