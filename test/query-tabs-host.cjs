const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const vscode = require("vscode");
const queryErrors = [];

/** Preserve typed query failures when an assertion fails before the native host's normal result. */
function observeQueries(explorer) {
  const failure = explorer.queries.failure.bind(explorer.queries);
  explorer.queries.failure = error => {
    queryErrors.push({ code: error?.code, domain: error?.domain, details: error?.details });
    failure(error);
  };
}

/** A failing native scenario must retain structured evidence before VS Code unloads its host. */
exports.run = async function () {
  try { await run(); }
  catch (error) {
    const fixture = JSON.parse(process.env.ESKA_HOST_FIXTURE);
    await fs.writeFile(path.join(fixture.root, "host-result.json"), JSON.stringify({ passed: false,
      error: String(error.stack ?? error), queryErrors }));
    throw error;
  }
};

/** Wait for a real controller/filesystem transition while retaining a bounded failure. */
async function until(predicate, message) {
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error(message);
}

/** Route typing through the editor's own text and undo model. */
async function replace(document, before, after) {
  const start = document.getText().indexOf(before); assert.ok(start >= 0, before);
  const edit = new vscode.WorkspaceEdit();
  edit.replace(document.uri, new vscode.Range(document.positionAt(start), document.positionAt(start + before.length)), after);
  assert.equal(await vscode.workspace.applyEdit(edit), true);
}

/** Wait for this save's real file event and metadata barrier before testing the next independent owner. */
async function saveAndSync(explorer, document, source) {
  let observed = false;
  const watchers = explorer.watchers.filter(subscription => typeof subscription.flush === "function");
  assert.ok(watchers.length, "production source watchers are active");
  const originals = watchers.map(watcher => watcher.add);
  for (const [index, watcher] of watchers.entries()) watcher.add = function (file) {
    if (file === source) observed = true;
    return originals[index].call(this, file);
  };
  try {
    const saved = await document.save();
    assert.equal(saved, true);
    await until(() => observed, "the saved source reached native file watchers");
    for (const watcher of watchers) await watcher.flush();
    return saved;
  } finally { for (const [index, watcher] of watchers.entries()) watcher.add = originals[index]; }
}

/** Find the declared metadata group without assuming the localized label or ObjectId serialization. */
async function objects(explorer, kind) {
  const [root] = await explorer.getChildren();
  const roots = await explorer.getChildren(root);
  const common = roots.find(row => row.node?.id.collection?.kind === "common");
  const groups = [...roots, ...await explorer.getChildren(common)];
  const group = groups.find(row => row.node?.id.collection?.metadataKind === kind);
  assert.ok(group, kind); return explorer.getChildren(group);
}

/** Exercise production tree rows, virtual SDBL, real save plans and dirty-owner Undo in the native host. */
async function run() {
  if (process.env.ESKA_HOST_LOCALE) assert.ok(vscode.env.language.startsWith(process.env.ESKA_HOST_LOCALE),
    `Requested UI locale ${process.env.ESKA_HOST_LOCALE}, actual ${vscode.env.language}`);
  const fixture = JSON.parse(process.env.ESKA_HOST_FIXTURE);
  if (process.env.ESKA_HOST_QUERY_RESTART && process.env.ESKA_HOST_RUN === "1") {
    await restoreRun(fixture); return;
  }
  const { schemaPath, formPath } = fixture.query;
  const schema = await fs.readFile(schemaPath, "utf8");
  const form = await fs.readFile(formPath, "utf8");
  const extension = vscode.extensions.all.find(value => value.packageJSON.name === "eska-explorer");
  const explorer = await extension.activate();
  observeQueries(explorer);
  await until(() => explorer.tree && explorer.connection.state.kind === "ready" && !explorer.support.loading, "query backend ready");
  assert.ok(explorer.connection.state.queryEditing, "the private profile uses the specified query backend");
  assert.ok(explorer.connection.recovery, "the installed adapter negotiates API 1.14 recovery");
  const recoveryMethods = new Set();
  const peer = explorer.connection.child;
  const request = peer.request.bind(peer);
  peer.request = async (method, ...args) => {
    if (method.startsWith("query/recovery")) recoveryMethods.add(method);
    return request(method, ...args);
  };
  const [template] = await objects(explorer, "common-template");
  const branches = (await explorer.getChildren(template)).filter(row => row.queryKind === "branch");
  assert.deepEqual(branches.map(row => explorer.getTreeItem(row).label), ["A", "B"]);
  const [first] = await explorer.getChildren(branches[0]);
  const [second] = await explorer.getChildren(branches[1]);
  assert.equal(explorer.getTreeItem(first).label, vscode.env.language.startsWith("ru") ? "Запрос" : "Query");
  await vscode.commands.executeCommand("eska.explorer.openQuery", first);
  let draft = vscode.window.activeTextEditor.document;
  assert.equal(draft.uri.scheme, "eska-query"); assert.equal(draft.languageId, "sdbl"); assert.equal(draft.getText(), "SELECT 1;\n// пакет 😀\nSELECT 77");
  await vscode.commands.executeCommand("eska.explorer.openQuery", first);
  assert.equal(vscode.window.activeTextEditor.document, draft, "reopening focuses the same document");
  await replace(draft, "SELECT 1", "SELECT 3");
  assert.equal(await saveAndSync(explorer, draft, schemaPath), true);
  const afterFirst = schema.replace("<![CDATA[SELECT 1;\r\n// пакет 😀\r\nSELECT 77]]>", "SELECT 3;\r\n// пакет 😀\r\nSELECT 77");
  assert.equal(await fs.readFile(schemaPath, "utf8"), afterFirst);
  const tabs = vscode.window.tabGroups.all.flatMap(group => group.tabs).filter(tab => tab.input instanceof vscode.TabInputText && tab.input.uri.toString() === draft.uri.toString());
  assert.equal(await vscode.window.tabGroups.close(tabs), true);
  const owner = await vscode.workspace.openTextDocument(vscode.Uri.file(schemaPath));
  await replace(owner, "<other>before</other>", "<other>unsaved</other>");
  const dirtyBefore = owner.getText();
  await vscode.commands.executeCommand("eska.explorer.openQuery", second);
  draft = vscode.window.activeTextEditor.document;
  assert.equal(draft.getText(), "SELECT 2");
  await replace(draft, "SELECT 2", "SELECT 4\nFROM T");
  assert.equal(await draft.save(), true);
  assert.equal(owner.isDirty, true);
  assert.equal(owner.getText(), dirtyBefore.replace("SELECT 2", "SELECT 4\r\nFROM T"));
  assert.equal(await fs.readFile(schemaPath, "utf8"), afterFirst, "unrelated dirty owner edits are not saved");
  await vscode.window.showTextDocument(owner, { preview: false });
  await vscode.commands.executeCommand("undo");
  assert.equal(owner.getText(), dirtyBefore, "single Undo retains the earlier dirty edit");
  await vscode.commands.executeCommand("redo");
  assert.equal(owner.getText(), dirtyBefore.replace("SELECT 2", "SELECT 4\r\nFROM T"));
  await vscode.window.showTextDocument(draft, { preview: false });
  await vscode.commands.executeCommand("eska.explorer.resumeQuery");
  assert.equal(await saveAndSync(explorer, owner, schemaPath), true, "the user can explicitly save the dirty XML owner");
  await vscode.commands.executeCommand("eska.explorer.resumeQuery");
  const savedOwner = owner.getText();
  const ownerSession = [...explorer.queries.sessions.values()].find(value => value.record.identity.kind === "dataSet");
  assert.equal(ownerSession.record.diskSnapshot, require("node:crypto").createHash("sha256").update(await fs.readFile(schemaPath)).digest("hex"));
  const queryTabs = vscode.window.tabGroups.all.flatMap(group => group.tabs).filter(tab => tab.input instanceof vscode.TabInputText && tab.input.uri.toString() === draft.uri.toString());
  assert.equal(await vscode.window.tabGroups.close(queryTabs), true);
  await replace(owner, "<other>unsaved</other>", "<other>local-again</other>");
  await vscode.commands.executeCommand("eska.explorer.openQuery", second);
  draft = vscode.window.activeTextEditor.document;
  assert.equal(draft.getText(), "SELECT 4\nFROM T");
  assert.equal(owner.getText(), savedOwner.replace("<other>unsaved</other>", "<other>local-again</other>"));
  let listRows;
  await until(async () => {
    const [formOwner] = await objects(explorer, "common-form");
    listRows = (await explorer.getChildren(formOwner)).filter(row => row.queryKind === "branch");
    return listRows.length === 2;
  }, "form query rows after the pending XML refresh");
  assert.deepEqual(listRows.map(row => explorer.getTreeItem(row).label), ["List", "Second"]);
  const [listQuery] = await explorer.getChildren(listRows[0]);
  const [secondListQuery] = await explorer.getChildren(listRows[1]);
  await vscode.commands.executeCommand("eska.explorer.openQuery", secondListQuery);
  const secondListDraft = vscode.window.activeTextEditor.document;
  await replace(secondListDraft, "SELECT 2", "SELECT 22");
  assert.equal(await saveAndSync(explorer, secondListDraft, formPath), true);
  const afterSecondList = form.replace("SELECT 2", "SELECT 22");
  assert.equal(await fs.readFile(formPath, "utf8"), afterSecondList);
  await vscode.commands.executeCommand("eska.explorer.openQuery", listQuery);
  const listDraft = vscode.window.activeTextEditor.document;
  assert.equal(listDraft.getText(), "SELECT 1");
  await replace(listDraft, "SELECT 1", "SELECT 9");
  assert.equal(await saveAndSync(explorer, listDraft, formPath), true);
  assert.equal(await fs.readFile(formPath, "utf8"), afterSecondList.replace("SELECT 1", "SELECT 9"));
  assert.equal([...explorer.queries.sessions.values()].filter(value => value.record.identity.kind === "dynamicList").length, 1);
  await replace(listDraft, "SELECT 9", "SELECT 10");
  await vscode.window.showTextDocument(draft, { preview: false });
  const external = (await fs.readFile(schemaPath, "utf8")).replace("<other>unsaved</other>", "<other>external</other>");
  await fs.writeFile(schemaPath, external);
  const beforeConflict = owner.getText();
  await replace(draft, "SELECT 4", "SELECT 5");
  assert.equal(await draft.save(), false, "external writes reject application and retain the dirty query");
  assert.equal(draft.isDirty, true); assert.equal(owner.getText(), beforeConflict);
  assert.equal(await fs.readFile(schemaPath, "utf8"), external);
  await explorer.queries.recovery.settled();
  const records = await explorer.queries.recovery.records();
  assert.equal(records.length, 2);
  assert.equal(records.find(record => record.identity.kind === "dataSet").ownerText, owner.getText());
  const storage = explorer.context.globalStorageUri.fsPath;
  assert.equal(storage.startsWith(fixture.root), false);
  const manifest = path.join(fixture.root, "eska.toml");
  const state = { schemaPath, schemaDisk: await fs.readFile(schemaPath, "utf8"), ownerText: owner.getText(),
    draftUri: draft.uri.toString(), draftText: draft.getText(), listUri: listDraft.uri.toString(),
    formPath, formDisk: await fs.readFile(formPath, "utf8"), storage, manifest: await fs.readFile(manifest, "utf8") };
  await fs.writeFile(path.join(fixture.root, "query-tabs-state.json"), JSON.stringify(state));
  const storedDraft = records.find(record => record.identity.kind === "dataSet");
  const stored = JSON.parse(await fs.readFile(path.join(storage, "query-drafts-v1", storedDraft.id + ".json"), "utf8"));
  assert.equal(Buffer.from(stored.draft, "base64").toString("utf8"), draft.getText());
  const closeQueries = explorer.queries.shutdown.bind(explorer.queries);
  let release;
  let waiting = false;
  const gate = new Promise(resolve => { release = resolve; });
  explorer.queries.shutdown = async () => { waiting = true; await gate; await closeQueries(); };
  const closing = explorer.shutdown();
  try {
    await until(() => waiting, "query shutdown barrier entered");
    await new Promise(resolve => setTimeout(resolve, 150));
    assert.equal(explorer.connection.state.kind, "ready", "metadata stays alive until query saves and storage settle");
  } finally { release(); await closing; }
  assert.ok(recoveryMethods.has("query/recoveryBegin"));
  assert.ok(recoveryMethods.has("query/recoveryAppend"));
  assert.ok(recoveryMethods.has("query/recoveryCommit"));
  assert.ok(recoveryMethods.has("query/recoveryClose"));
  // The next real process must restore private data before a metadata workspace can be opened.
  await fs.writeFile(manifest, "[project\ninvalid manifest");
  await fs.writeFile(path.join(fixture.root, "host-result.json"), JSON.stringify({ passed: true, suite: "query-tabs",
    vscode: vscode.version, locale: vscode.env.language, node: process.version, cleanXmlSave: true, dirtyXmlSave: true, wholePackage: true,
    ownerUndoRedo: true, noExtraXmlDiff: true, repeatedOpen: true, manualLists: 2, automaticListInvented: false,
    privateRecoveryRecords: records.length, externalConflictRetainsDraft: true, analyzerRequired: false, shutdownWaitsForQueries: true,
    backendRecovery: true, recoveryMethods: [...recoveryMethods].sort() }));
}

/** A fresh extension host must revalidate source snapshots and must never autosave a restored draft. */
async function restoreRun(fixture) {
  const state = JSON.parse(await fs.readFile(path.join(fixture.root, "query-tabs-state.json"), "utf8"));
  const extension = vscode.extensions.all.find(value => value.packageJSON.name === "eska-explorer");
  const explorer = await extension.activate();
  observeQueries(explorer);
  await vscode.commands.executeCommand("eska.explorer.restart");
  await until(() => explorer.connection.state.kind === "error" && explorer.connection.state.error.code === "manifestInvalid"
    && explorer.connection.recovery, "private recovery stays available despite the broken manifest");
  const conflict = await vscode.workspace.openTextDocument(vscode.Uri.parse(state.draftUri));
  await vscode.window.showTextDocument(conflict, { preview: false });
  await until(() => conflict.isDirty && conflict.getText() === state.draftText, "query recovered as a real dirty document");
  assert.equal(await conflict.save(), false, "resumption is explicit even when a restored tab becomes dirty");
  assert.equal(await fs.readFile(state.schemaPath, "utf8"), state.schemaDisk);
  const id = conflict.uri.path.split("/")[1];
  const snapshot = conflict.uri.with({ path: `/${id}/owner.xml` });
  assert.equal(Buffer.from(await vscode.workspace.fs.readFile(snapshot)).toString("utf8"), state.ownerText);
  assert.equal((await vscode.workspace.fs.stat(snapshot)).permissions, vscode.FilePermission.Readonly);
  await assert.rejects(vscode.workspace.fs.writeFile(snapshot, Buffer.from("forbidden")));
  assert.equal(explorer.tree, undefined, "owner snapshots and dirty drafts do not depend on metadata readiness");
  await fs.writeFile(path.join(fixture.root, "eska.toml"), state.manifest);
  await vscode.commands.executeCommand("eska.explorer.restart");
  await until(() => explorer.tree && explorer.connection.state.kind === "ready" && !explorer.support.loading, "repaired query backend ready");
  await vscode.commands.executeCommand("eska.explorer.compareQueryOwner");
  const comparison = vscode.window.tabGroups.all.flatMap(group => group.tabs).find(tab => tab.input instanceof vscode.TabInputTextDiff
    && tab.input.original.toString() === snapshot.toString());
  assert.ok(comparison, "owner comparison uses the retained original snapshot");
  assert.equal(await vscode.window.tabGroups.close(comparison), true);
  assert.equal((await explorer.queries.recovery.records()).length, 2, "closing a snapshot does not discard its query session");
  await vscode.window.showTextDocument(conflict, { preview: false });
  await vscode.commands.executeCommand("eska.explorer.resumeQuery");
  assert.equal(await conflict.save(), false, "a conflicting owner cannot be resumed silently");
  assert.equal(conflict.getText(), state.draftText);
  const resumed = await vscode.workspace.openTextDocument(vscode.Uri.parse(state.listUri));
  await vscode.window.showTextDocument(resumed, { preview: false });
  await until(() => resumed.isDirty && resumed.getText() === "SELECT 10", "independent list draft recovered");
  assert.equal(await resumed.save(), false);
  assert.equal(await fs.readFile(state.formPath, "utf8"), state.formDisk);
  await vscode.commands.executeCommand("eska.explorer.resumeQuery");
  assert.equal(await resumed.save(), true, "matching owner snapshots can resume under new process-local editor versions");
  assert.equal(await fs.readFile(state.formPath, "utf8"), state.formDisk.replace("SELECT 9", "SELECT 10"));
  assert.equal(await fs.readFile(state.schemaPath, "utf8"), state.schemaDisk);
  await vscode.commands.executeCommand("eska.explorer.disconnect");
  assert.equal(explorer.connection.state.kind, "disconnected");
  const offlineText = conflict.getText() + "\n// offline draft 😀";
  const offlineEdit = new vscode.WorkspaceEdit();
  offlineEdit.insert(conflict.uri, conflict.positionAt(conflict.getText().length), "\n// offline draft 😀");
  assert.equal(await vscode.workspace.applyEdit(offlineEdit), true);
  const cleanTabs = vscode.window.tabGroups.all.flatMap(group => group.tabs).filter(tab => tab.input instanceof vscode.TabInputText
    && tab.input.uri.toString() === resumed.uri.toString());
  assert.ok(cleanTabs.length, "the clean list remains open across disconnect");
  assert.equal(await vscode.window.tabGroups.close(cleanTabs), true);
  await vscode.commands.executeCommand("eska.explorer.restart");
  await until(() => explorer.tree && explorer.connection.state.kind === "ready" && !explorer.support.loading, "backend ready after offline close");
  await explorer.queries.ready;
  const remaining = await explorer.queries.recovery.records();
  assert.equal(remaining.length, 1, "offline clean close is removed after reconnect, without resurrection");
  assert.equal(remaining[0].draft, offlineText, "offline input is reconciled without losing the independent draft");
  await fs.writeFile(path.join(fixture.root, "host-result.json"), JSON.stringify({ passed: true, suite: "query-tabs-cold-recovery",
    vscode: vscode.version, locale: vscode.env.language, dirtyDraftRecovered: true, originalDirtyXmlSnapshotRetained: true, automaticApply: false,
    conflictRetainsDraft: true, explicitResumeUnderFreshEditorVersion: true, independentOwnerSave: true,
    backendRecovery: true, recoveryWithBrokenManifest: true, offlineInputReconciled: true,
    offlineCleanCloseRetainedUntilAcknowledged: true }));
}
