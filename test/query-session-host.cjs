const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const vscode = require("vscode");

/** Wait on an actual model/controller transition, retaining a bounded assertion on failure. */
async function until(predicate, message) {
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 40));
  }
  throw new Error(message);
}

/** Native edits keep their own version and Undo history, independently of the backend checkpoint. */
async function replace(document, before, after) {
  const start = document.getText().indexOf(before); assert.ok(start >= 0, before);
  const edit = new vscode.WorkspaceEdit();
  edit.replace(document.uri, new vscode.Range(document.positionAt(start), document.positionAt(start + before.length)), after);
  assert.equal(await vscode.workspace.applyEdit(edit), true);
}

/** Resolve actual tree rows without guessing their localized label or opaque identity. */
async function query(explorer, kind, label) {
  const [root] = await explorer.getChildren();
  const roots = await explorer.getChildren(root);
  const common = roots.find(row => row.node?.id.collection?.kind === "common");
  const groups = [...roots, ...await explorer.getChildren(common)];
  const group = groups.find(row => row.node?.id.collection?.metadataKind === kind);
  const [owner] = await explorer.getChildren(group);
  const branch = (await explorer.getChildren(owner)).find(row => row.queryKind === "branch" && explorer.getTreeItem(row).label === label);
  assert.ok(branch, label);
  return (await explorer.getChildren(branch))[0];
}

/** Watch the real source file event before issuing another query operation under the resulting generation. */
function sourceEvent(explorer, source) {
  let observed = false;
  const watchers = explorer.watchers.filter(watcher => typeof watcher.flush === "function");
  const originals = watchers.map(watcher => watcher.add);
  watchers.forEach((watcher, index) => {
    watcher.add = function (file) { if (file === source) observed = true; return originals[index].call(this, file); };
  });
  return async () => {
    try {
      await until(() => observed, "native source event arrived");
      for (const watcher of watchers) await watcher.flush();
    } finally { watchers.forEach((watcher, index) => { watcher.add = originals[index]; }); }
  };
}

/** Close only this clean query resource and wait until its exact checkpoint is removed. */
async function closeQuery(explorer, document) {
  assert.equal(document.isDirty, false);
  const tabs = vscode.window.tabGroups.all.flatMap(group => group.tabs).filter(tab => tab.input instanceof vscode.TabInputText
    && tab.input.uri.toString() === document.uri.toString());
  assert.equal(await vscode.window.tabGroups.close(tabs), true);
  await until(async () => (await explorer.queries.recovery.records()).length === 0, "clean query checkpoint released");
}

/** Hold a real application receipt before or after its backend execution, with no product-code fault injection. */
function receiptGate(explorer, after) {
  const peer = explorer.connection.child;
  const original = peer.request.bind(peer);
  let entered, release, armed = true;
  const ready = new Promise(resolve => { entered = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  peer.request = async (method, ...args) => {
    if (method !== "query/sessionApplied" || !armed) return original(method, ...args);
    armed = false;
    if (after) { const result = await original(method, ...args); entered(); await gate; return result; }
    entered(); await gate; throw new Error("simulated interrupted native receipt");
  };
  return { ready, release, restore() { peer.request = original; } };
}

/** The native query UI and every metadata writer observe the same backend source ownership. */
async function ownerWritable(explorer, row, expected) {
  const owner = row.owner;
  const editing = await explorer.tree.request(owner.project, "metadata/propertyEditing", { objectId: owner.node.id.objectId });
  assert.equal(editing.writable, expected, "backend descriptor writes follow the source-session lifetime");
  const file = path.join(owner.project.info.sourcePath.value, editing.source.value);
  if (expected) assert.equal((await explorer.support.languageWriteAccess([file]))(), true);
  else await assert.rejects(explorer.support.languageWriteAccess([file]), { code: "sourceChanged" });
}

/** New input during an already acknowledged source application must retain its own dirty native revision. */
async function newerInput(explorer, fixture) {
  const row = await query(explorer, "common-template", "A");
  const previousAccess = await explorer.support.languageWriteAccess([fixture.query.schemaPath]);
  await vscode.commands.executeCommand("eska.explorer.openQuery", row);
  assert.equal(previousAccess(), false, "a native authorization from before source ownership cannot be reused");
  await ownerWritable(explorer, row, false);
  const draft = vscode.window.activeTextEditor.document;
  await replace(draft, "SELECT 1", "SELECT 7");
  const sync = sourceEvent(explorer, fixture.query.schemaPath);
  const held = receiptGate(explorer, true);
  const saving = draft.save();
  try {
    await held.ready;
    await replace(draft, "SELECT 7", "SELECT 8");
  } finally { held.release(); }
  assert.equal(await saving, false, "the newer native revision remains unsaved after the earlier save completes");
  held.restore();
  await sync();
  await explorer.queries.recovery.settled();
  const [record] = await explorer.queries.recovery.records();
  assert.ok(record.base.startsWith("SELECT 7"));
  assert.ok(record.draft.startsWith("SELECT 8"));
  assert.ok(draft.getText().startsWith("SELECT 8"));
  await until(() => vscode.window.tabGroups.all.some(group => group.tabs.some(tab => tab.input instanceof vscode.TabInputText
    && tab.input.uri.toString() === draft.uri.toString() && tab.isDirty)), "newer native revision remains dirty after the save event");
  assert.ok((await fs.readFile(fixture.query.schemaPath, "utf8")).includes("SELECT 7"));
  const nextSync = sourceEvent(explorer, fixture.query.schemaPath);
  assert.equal(await draft.save(), true);
  await nextSync();
  assert.ok((await fs.readFile(fixture.query.schemaPath, "utf8")).includes("SELECT 8"));
  await closeQuery(explorer, draft);
  await ownerWritable(explorer, row, true);
}

/** A clean native query can still represent an unapplied draft after its recovered source baseline advances. */
async function interruptedApply(explorer, fixture) {
  const row = await query(explorer, "common-form", "List");
  await vscode.commands.executeCommand("eska.explorer.openQuery", row);
  await ownerWritable(explorer, row, false);
  let draft = vscode.window.activeTextEditor.document;
  const uri = draft.uri;
  await replace(draft, "SELECT 1", "SELECT 10");
  const sync = sourceEvent(explorer, fixture.query.formPath);
  const held = receiptGate(explorer, false);
  const saving = draft.save();
  try {
    await held.ready;
    await vscode.commands.executeCommand("undo");
    assert.equal(draft.getText(), "SELECT 1");
  } finally { held.release(); }
  assert.equal(await saving, false);
  held.restore();
  await sync();
  await explorer.queries.recovery.settled();
  await ownerWritable(explorer, row, true);
  await vscode.commands.executeCommand("workbench.action.files.revert");
  draft = await vscode.workspace.openTextDocument(uri);
  await vscode.window.showTextDocument(draft, { preview: false });
  assert.equal(draft.getText(), "SELECT 1");
  assert.equal(draft.isDirty, false, "native saved baseline is still the original query");
  const [record] = await explorer.queries.recovery.records();
  const checkpoint = path.join(explorer.context.globalStorageUri.fsPath, "query-drafts-v1", record.id + ".json");
  const pending = JSON.parse(await fs.readFile(checkpoint, "utf8"));
  assert.equal(pending.storageVersion, 2);
  assert.equal(Buffer.from(pending.draft, "base64").toString("utf8"), "SELECT 1");
  assert.ok((await fs.readFile(fixture.query.formPath, "utf8")).includes("SELECT 10"));
  await vscode.commands.executeCommand("eska.explorer.resumeQuery");
  await ownerWritable(explorer, row, false);
  assert.equal(draft.getText(), "SELECT 1", "resume does not replace the latest native draft");
  assert.equal(draft.isDirty, true, "the unapplied draft is saveable under the recovered baseline");
  const cleared = JSON.parse(await fs.readFile(checkpoint, "utf8"));
  assert.equal(cleared.storageVersion, 1);
  assert.ok((await fs.readFile(fixture.query.formPath, "utf8")).includes("SELECT 10"), "reconciliation never replays a source edit");
  const nextSync = sourceEvent(explorer, fixture.query.formPath);
  assert.equal(await draft.save(), true);
  await nextSync();
  const form = await fs.readFile(fixture.query.formPath, "utf8");
  assert.equal(form.includes("SELECT 10"), false);
  assert.ok(form.includes("SELECT 1"));
  await closeQuery(explorer, draft);
  await ownerWritable(explorer, row, true);
}

/** Exercise the production API 1.16 adapter and preserve diagnostics on a failing native assertion. */
exports.run = async function () {
  const fixture = JSON.parse(process.env.ESKA_HOST_FIXTURE);
  const errors = [];
  try {
    const extension = vscode.extensions.all.find(value => value.packageJSON.name === "eska-explorer");
    const explorer = await extension.activate();
    await until(() => explorer.tree && explorer.connection.state.kind === "ready" && !explorer.support.loading, "source backend ready");
    assert.ok(explorer.connection.recovery.sessions);
    assert.ok(explorer.connection.sources);
    await vscode.workspace.getConfiguration("eska.explorer").update("supportPolicy", false, vscode.ConfigurationTarget.Workspace);
    await until(() => !explorer.support.enabled && !explorer.support.loading, "ordinary support opt-out is visible");
    if (process.env.ESKA_HOST_LOCALE) assert.ok(vscode.env.language.startsWith(process.env.ESKA_HOST_LOCALE));
    const failure = explorer.queries.failure.bind(explorer.queries);
    explorer.queries.failure = error => { errors.push({ message: String(error), code: error?.code, domain: error?.domain, details: error?.details }); failure(error); };
    await newerInput(explorer, fixture);
    await interruptedApply(explorer, fixture);
    assert.equal(errors.length, 1);
    assert.ok(errors[0].message.includes("simulated interrupted native receipt"));
    await fs.writeFile(path.join(fixture.root, "host-result.json"), JSON.stringify({ passed: true, suite: "query-source-sessions",
      vscode: vscode.version, locale: vscode.env.language, backendSourceSessions: true, newerInputDuringReceipt: true,
      interruptedNativeReceipt: true, latestDraftPreserved: true, explicitReconciliation: true, cleanDraftMarkedDirty: true,
      noAutomaticReplay: true, cleanCloseReleasesCheckpoint: true, backendSourceWriteFence: true,
      backendFenceReleasedOnError: true, restoredFenceUntilClose: true, languageWritesRespectSourceOwnership: true,
      supportDisabledDoesNotReleaseOwnership: true, staleNativeAuthorizationRejected: true, injectedErrors: errors }));
  } catch (error) {
    await fs.writeFile(path.join(fixture.root, "host-result.json"), JSON.stringify({ passed: false, error: String(error.stack ?? error), errors }));
    throw error;
  }
};
