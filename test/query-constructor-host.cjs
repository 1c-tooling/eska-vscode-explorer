const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const vscode = require("vscode");

/** Every native transition has an exact predicate and a bounded deadline. */
async function until(action, label) {
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) { if (await action()) return; await new Promise(resolve => setTimeout(resolve, 45)); }
  throw new Error(label);
}

/** Use the native undo stack rather than replacing private recovery data. */
async function replace(document, before, after) {
  const offset = document.getText().indexOf(before); assert.ok(offset >= 0, before);
  const edit = new vscode.WorkspaceEdit(); edit.replace(document.uri, new vscode.Range(document.positionAt(offset), document.positionAt(offset + before.length)), after);
  assert.equal(await vscode.workspace.applyEdit(edit), true);
}

/** The contextual public command always selects the original module literal through ESKA. */
async function openQuery(owner) {
  const editor = await vscode.window.showTextDocument(owner, { preview: false });
  const at = owner.positionAt(owner.getText().indexOf("SELECT ") + 3); editor.selection = new vscode.Selection(at, at);
  await vscode.commands.executeCommand("eska.explorer.editBslQuery");
  await until(() => vscode.window.activeTextEditor?.document.uri.scheme === "eska-query", "query tab");
  return vscode.window.activeTextEditor.document;
}

/** The public command creates the installed production panel; only Native dialog selection is scripted. */
async function openConstructor(explorer, document) {
  await Promise.all([vscode.commands.executeCommand("eska.explorer.queryConstructor", document.uri),
    vscode.commands.executeCommand("eska.explorer.queryConstructor", document.uri)]);
  await until(() => explorer.queryDesigner.views.has(document.uri.toString()), "constructor panel");
  const view = explorer.queryDesigner.views.get(document.uri.toString());
  await until(() => !view.busy && (!view.binding.core.limits.visual || view.catalog || view.metadataFailed), "constructor ready message acknowledged");
  return view;
}

/** Locate a returned metadata identity without matching translated display names. */
async function objects(explorer, kind) {
  const [root] = await explorer.getChildren(), roots = await explorer.getChildren(root);
  const common = roots.find(row => row.node?.id.collection?.kind === "common");
  const groups = [...roots, ...await explorer.getChildren(common)], group = groups.find(row => row.node?.id.collection?.metadataKind === kind);
  assert.ok(group); return explorer.getChildren(group);
}

/** Constructor edits stay private; the subsequent explicit XML query Save uses the common native receipt. */
async function xmlConstructor(explorer, fixture, accepted) {
  let phase='fixture-owner';
  try {
    let xml = await vscode.workspace.openTextDocument(vscode.Uri.file(fixture.query.schemaPath));
    // Fixture input predates workspace/open; a live XML save would invalidate sessions through the real file watcher.
    const baselineOwner = xml.getText(); assert.ok(baselineOwner.includes("<other>prior input 😀</other>"));
    const disk = await fs.readFile(fixture.query.schemaPath);
    phase='discovery';
    const [template] = await objects(explorer, "common-template"), branches = await explorer.getChildren(template);
    const branch = branches.find(row => row.queryKind === "branch"), [entry] = await explorer.getChildren(branch);
    await vscode.commands.executeCommand("eska.explorer.openQuery", entry);
    let draft = vscode.window.activeTextEditor.document; assert.equal(draft.getText(), "SELECT Long");
    await replace(draft, "SELECT Long", "SELECT 1 AS Draft");
    phase='constructor-noop';
    const before = draft.getText(); let view = await openConstructor(explorer, draft);
    await explorer.queryDesigner.receive(view, { revision: view.binding.core.model.revision, type: "apply" });
    draft = vscode.window.activeTextEditor.document;
    xml = await vscode.workspace.openTextDocument(xml.uri);
    assert.equal(draft.getText(), before); assert.equal(draft.isDirty, true, "XML draft remains saveable after no-op constructor");
    assert.equal(xml.getText(), baselineOwner); assert.deepEqual(await fs.readFile(fixture.query.schemaPath), disk);
    phase='constructor-edit';
    view = await openConstructor(explorer, draft);
    await explorer.queryDesigner.receive(view, { revision: view.binding.core.model.revision, type: "action", action: { kind: "replace", selection: { statement: 0, clause: 0, item: 0 }, text: "2 AS Edited" } });
    await explorer.queryDesigner.receive(view, { revision: view.binding.core.model.revision, type: "apply" }); draft = vscode.window.activeTextEditor.document;
    const working = draft.getText(); assert.equal(working, "SELECT 2 AS Edited");
    await vscode.commands.executeCommand("undo"); assert.equal(draft.getText(), before);
    await vscode.commands.executeCommand("redo"); assert.equal(draft.getText(), working);
    phase='first-query-save';
    assert.equal(await draft.save(), false, "source confirmation and comment decisions precede XML application");
    let choices = 0;
    explorer.queries.sourceCommentChoices = async (source, info, document) => {
      choices++; assert.equal(info.needsDecision, true);
      const point = document.positionAt(document.getText().length), mapped = await source.comments([point]);
      assert.notEqual(mapped.positions[0].queryOffset, null);
      return info.comments.map(comment => ({ comment: comment.comment, queryOffset: mapped.positions[0].queryOffset }));
    };
    phase='place-comments';
    await vscode.commands.executeCommand("eska.explorer.placeQueryComments"); assert.equal(choices, 1);
    phase='resume';
    await vscode.commands.executeCommand("eska.explorer.resumeQuery");
    phase='final-query-save';
    assert.equal(await draft.save(), true);
    phase='inspect-saved-owner';
    xml = await vscode.workspace.openTextDocument(xml.uri);
    assert.ok(xml.getText().includes("SELECT 2 AS Edited<!--source 😀-->")); assert.ok(xml.getText().includes("<other>prior input 😀</other>"));
    assert.equal(xml.isDirty, false); assert.equal((await fs.readFile(fixture.query.schemaPath,"utf8")).replace(/^\uFEFF/,""),xml.getText());
    await vscode.window.showTextDocument(xml); await vscode.commands.executeCommand("undo"); assert.equal(xml.getText(), baselineOwner);
    accepted.push("xml_constructor_keeps_private_dirty_draft_then_explicit_xml_save_places_source_comments_and_native_undo");
  } catch(error){error.testPhase=phase;throw error;}
}

/** All visual clause intentions share the same core model; unsupported package statements remain exact text. */
async function clauseAndReadonly(explorer, owner, accepted) {
  let draft = await openQuery(owner);
  const original = draft.getText(), opaque = "SELECT {Field} FROM T;\n", text = opaque + "SELECT A";
  await replace(draft, original, text);
  let view = await openConstructor(explorer, draft);
  assert.equal(view.binding.core.model.statements[0].unavailable, "unsupported_construct");
  for (const [clause, expression, join] of [["fields", "B"], ["sources", "T AS Main"], ["joins", "U AS Other ON Main.ID = Other.ID", "left"],
    ["conditions", "A = &Parameter"], ["group", "A"], ["order", "A DESC"]]) {
    await explorer.queryDesigner.receive(view, { revision: view.binding.core.model.revision, type: "action", action: { kind: "append", statement: 1, clause, text: expression, ...(join ? { join } : {}) } });
    assert.equal(view.binding.core.model.text.startsWith(opaque), true);
  }
  const model = view.binding.core.model;
  assert.deepEqual(new Set(model.statements[1].clauses.map(value => value.kind)), new Set(["fields", "sources", "joins", "conditions", "group", "order"]));
  await explorer.queryDesigner.receive(view, { revision: view.binding.core.model.revision, type: "apply" }); draft = vscode.window.activeTextEditor.document;
  assert.equal(draft.getText(), model.text); await vscode.commands.executeCommand("undo"); assert.equal(draft.getText(), text);
  await vscode.commands.executeCommand("eska.explorer.cancelQuery", draft.uri);
  const files = vscode.workspace.getConfiguration("files", owner.uri);
  await files.update("readonlyInclude", { "**/ObjectModule.bsl": true }, vscode.ConfigurationTarget.Workspace);
  try {
    draft = await openQuery(owner); const before = draft.getText(); view = await openConstructor(explorer, draft);
    assert.equal(view.binding.core.model.writable, false);
    assert.ok(view.binding.core.model.statements[0].append.every(value => value.unavailable === "read_only"));
    await assert.rejects(view.binding.core.action({ kind: "append", statement: 0, clause: "fields", text: "9" }), error => error.details?.reason === "user_read_only");
    await explorer.queryDesigner.receive(view, { revision: view.binding.core.model.revision, type: "apply" }); draft = vscode.window.activeTextEditor.document;
    assert.equal(draft.getText(), before); assert.equal((await vscode.workspace.fs.stat(draft.uri)).permissions, vscode.FilePermission.Readonly);
    await vscode.commands.executeCommand("eska.explorer.cancelQuery", draft.uri);
  } finally { await files.update("readonlyInclude", undefined, vscode.ConfigurationTarget.Workspace); }
  accepted.push("six_clause_operations_preserve_opaque_package_and_readonly_constructor_cannot_grant_write_access");
}

/** Losing the real process discards only unaccepted model operations, retaining the earlier canonical checkpoint. */
async function interrupted(explorer, owner, accepted) {
  let draft = await openQuery(owner); const before = draft.getText();
  await replace(draft, before, before + "\nORDER BY A"); const checkpoint = draft.getText();
  const view = await openConstructor(explorer, draft), id = [...explorer.queries.sessions.keys()].find(key => explorer.queries.sessions.get(key).design === view.binding);
  await explorer.queryDesigner.receive(view, { revision: view.binding.core.model.revision, type: "action", action: { kind: "append", statement: 0, clause: "fields", text: "9 AS Unaccepted" } });
  const oldPid = explorer.connection.child.pid; process.kill(oldPid, "SIGKILL");
  await until(() => explorer.connection.state.kind === "error" && !view.binding.current, "constructor observes real backend loss");
  await vscode.commands.executeCommand("eska.explorer.restart");
  await until(() => explorer.connection.state.kind === "ready" && explorer.connection.child.pid !== oldPid && !explorer.support.loading, "fresh backend after constructor loss");
  await explorer.queries.ready;
  await explorer.queryDesigner.receive(view, { revision: view.binding.core.model.revision, type: "cancel" });
  draft = vscode.window.activeTextEditor.document; assert.equal(draft.getText(), checkpoint); assert.equal(draft.getText().includes("Unaccepted"), false);
  assert.equal(explorer.queries.sessions.get(id).resumed, false);
  await vscode.commands.executeCommand("eska.explorer.resumeQuery"); assert.equal(explorer.queries.sessions.get(id).resumed, true);
  await vscode.commands.executeCommand("eska.explorer.cancelQuery", draft.uri);
  accepted.push("backend_crash_retains_checkpoint_discards_unaccepted_model_and_requires_explicit_resume");
}

/** Markup-like query strings are rendered literally in the real installed webview. */
async function visualDom(explorer, owner, accepted) {
  if (!process.env.ESKA_HOST_DEBUG_PORT) return;
  let draft = await openQuery(owner);
  const text = 'SELECT "<img src=x onerror=globalThis.queryExecuted=true>" AS Safe, 2 AS B FROM T WHERE A = &P GROUP BY A ORDER BY A';
  await replace(draft, draft.getText(), text);
  const view = await openConstructor(explorer, draft);
  accepted.push(await require('./query-constructor-dom.cjs').exercise({ explorer, view, until, locale: vscode.env.language }));
  draft = vscode.window.activeTextEditor.document; assert.equal(draft.getText(), text);
  await vscode.commands.executeCommand("eska.explorer.cancelQuery", draft.uri);
}

/** Constructor isolation starts after the modal owner's native close decision; apply remains one undoable draft edit. */
exports.run = async function () {
  const fixture = JSON.parse(process.env.ESKA_HOST_FIXTURE), accepted = [], errors = [];
  let explorer;
  try {
    assert.equal(vscode.env.language, process.env.ESKA_HOST_LOCALE ?? "en");
    explorer = await vscode.extensions.all.find(value => value.packageJSON.name === "eska-explorer").activate();
    const originalExplain = explorer.queries.explain.bind(explorer.queries);
    explorer.queries.explain = error => { errors.push({ code: error.code, details: error.details, message: String(error.stack ?? error) }); originalExplain(error); };
    await until(() => explorer.tree && explorer.connection.state.kind === "ready" && !explorer.support.loading, "metadata ready");
    const disk = await fs.readFile(fixture.module); let owner = await vscode.workspace.openTextDocument(vscode.Uri.file(fixture.module));
    let draft = await openQuery(owner); const before = draft.getText(), uri = draft.uri;
    owner = await vscode.workspace.openTextDocument(owner.uri);
    const capturedOwner = owner.getText(), ownerVersion = owner.version;
    await vscode.commands.executeCommand("workbench.action.splitEditorRight");
    const view = await openConstructor(explorer, draft);
    assert.equal(view.binding.core.model.text, before);
    assert.equal(vscode.window.tabGroups.all.some(group => group.tabs.some(tab => tab.input instanceof vscode.TabInputText && tab.input.uri.toString() === uri.toString())), false);
    assert.equal((await vscode.workspace.fs.stat(uri)).permissions, vscode.FilePermission.Readonly);
    assert.equal(owner.version, ownerVersion); assert.equal(owner.getText(), capturedOwner);
    accepted.push("all_editable_splits_replaced_by_constructor_and_core_draft_lock");
    const displayedRevision = view.binding.core.model.revision;
    await explorer.queryDesigner.receive(view, { revision: view.binding.core.model.revision, type: "action", action: { kind: "move", selection: { statement: 0, clause: 0, item: 1 }, to: 0 } });
    assert.ok(view.binding.core.model.text.indexOf("// field B") < view.binding.core.model.text.indexOf("1 AS A"));
    const currentSnapshot = structuredClone(view.binding.core.model);
    for (const type of ["action", "preview", "apply"]) {
      await assert.rejects(explorer.queryDesigner.receive(view, { revision: displayedRevision, type,
        action: { kind: "replace", selection: { statement: 0, clause: 0, item: 0 }, text: "9 AS Stale" } }), error => error.code === "obsolete");
      assert.deepEqual(view.binding.core.model, currentSnapshot);
    }
    accepted.push("late_webview_actions_previews_and_apply_reject_the_displayed_old_revision");
    let choices = 0; explorer.queryDesigner.commentDecision = async () => { choices++; return "keep"; };
    await explorer.queryDesigner.receive(view, { revision: view.binding.core.model.revision, type: "action", action: { kind: "remove", selection: { statement: 0, clause: 0, item: 0 } } });
    assert.equal(choices, 1); assert.ok(view.binding.core.model.text.includes("// field B"));
    await explorer.queryDesigner.receive(view, { revision: view.binding.core.model.revision, type: "action", action: { kind: "append", statement: 0, clause: "fields", text: "3 AS C" } });
    const working = view.binding.core.model.text;
    await explorer.queryDesigner.receive(view, { revision: view.binding.core.model.revision, type: "apply" });
    await until(() => vscode.window.activeTextEditor?.document.uri.toString() === uri.toString(), "same query draft reopened");
    draft = vscode.window.activeTextEditor.document;
    assert.equal(draft.getText(), working); assert.equal(owner.getText(), capturedOwner); assert.deepEqual(await fs.readFile(fixture.module), disk);
    await vscode.commands.executeCommand("undo"); assert.equal(draft.getText(), before, "one native undo returns the pre-constructor draft");
    await vscode.commands.executeCommand("redo"); assert.equal(draft.getText(), working);
    accepted.push("comments_follow_nodes_explicit_keep_and_same_draft_single_undo_redo");
    await vscode.commands.executeCommand("eska.explorer.applyQuery", uri);
    owner = await vscode.workspace.openTextDocument(owner.uri);
    assert.ok(owner.getText().includes("3 AS C")); assert.ok(owner.getText().includes("Other = 42")); assert.equal(owner.isDirty, true);
    assert.deepEqual(await fs.readFile(fixture.module), disk);
    await vscode.window.showTextDocument(owner); await vscode.commands.executeCommand("undo"); assert.equal(owner.getText(), capturedOwner);
    accepted.push("constructor_result_uses_existing_explicit_bsl_apply_without_disk_save");
    draft = await openQuery(owner); const unchanged = draft.getText();
    let next = await openConstructor(explorer, draft);
    await explorer.queryDesigner.receive(next, { revision: next.binding.core.model.revision, type: "apply" });
    draft = vscode.window.activeTextEditor.document; assert.equal(draft.getText(), unchanged); assert.equal(owner.getText(), capturedOwner);
    accepted.push("opening_and_applying_without_operations_preserves_exact_draft_and_owner");
    next = await openConstructor(explorer, draft);
    await explorer.queryDesigner.receive(next, { revision: next.binding.core.model.revision, type: "action", action: { kind: "append", statement: 0, clause: "order", text: "A" } });
    await explorer.queryDesigner.receive(next, { revision: next.binding.core.model.revision, type: "cancel" });
    draft = vscode.window.activeTextEditor.document; assert.equal(draft.getText(), unchanged); assert.equal(owner.getText(), capturedOwner);
    assert.notEqual((await vscode.workspace.fs.stat(draft.uri)).permissions, vscode.FilePermission.Readonly);
    accepted.push("cancel_discards_only_unaccepted_constructor_operations_and_releases_its_lock");
    await vscode.commands.executeCommand("eska.explorer.cancelQuery", draft.uri);
    await clauseAndReadonly(explorer, owner, accepted);
    await visualDom(explorer, owner, accepted);
    await interrupted(explorer, owner, accepted);
    await xmlConstructor(explorer, fixture, accepted);
    await fs.writeFile(path.join(fixture.root, "host-result.json"), JSON.stringify({ passed: true, suite: "query-constructor", accepted, errors, locale: vscode.env.language }));
  } catch (error) {
    await fs.writeFile(path.join(fixture.root, "host-result.json"), JSON.stringify({ passed: false, suite: "query-constructor", accepted, errors, error: String(error.stack ?? error)+" "+JSON.stringify({details:error.details,phase:error.testPhase,accepted,errors}) })); throw error;
  }
};
