const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const vscode = require("vscode");

/** Observe real backend policy before checking the editor; a pending policy is not permission. */
async function until(predicate, reason) {
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.fail(reason);
}

/** Only the runner's synthetic configuration receives support rules. */
function support(rule) {
  const owner = "11111111-1111-1111-1111-111111111111";
  const attribute = "22222222-2222-2222-2222-222222222222";
  return `{6,0,1,${owner},0,${owner},"1","Vendor","Fixture",2,${rule},0,${owner},${owner},0,0,${attribute},${attribute},0,0,0,1,0,0,0,1,0,1,0,1,1,1,1}`;
}

/** Await actual native typing rather than infer a buffer lock from a setting or decoration. */
async function type(document, text) {
  await until(() => vscode.window.activeTextEditor?.document === document, "typing targets the requested native editor");
  const before = document.getText();
  await vscode.commands.executeCommand("type", { text });
  await new Promise(resolve => setTimeout(resolve, 100));
  return document.getText() !== before;
}

/** Test the existing support mode itself, including its deliberate preservation of dirty native models. */
async function run(fixture) {
  const uri = vscode.Uri.file(fixture.module);
  const rules = path.join(fixture.source, "Ext/ParentConfigurations.bin");
  const settings = path.join(fixture.root, ".vscode/settings.json");
  const original = await fs.readFile(fixture.module);
  const beforeMode = (await fs.stat(fixture.module)).mode;
  const beforeSettings = JSON.parse(await fs.readFile(settings, "utf8"));
  await fs.mkdir(path.dirname(rules), { recursive: true });
  await fs.writeFile(rules, support(1));
  const explorer = await vscode.extensions.all.find(extension => extension.packageJSON.name === "eska-explorer").activate();
  await vscode.commands.executeCommand("eska.explorer.connect");
  await until(() => explorer.support.provideFileDecoration(uri)?.badge === "S" && !explorer.support.loading,
    "backend confirms editable support before the owner is dirtied");

  const document = await vscode.workspace.openTextDocument(uri);
  const editor = await vscode.window.showTextDocument(document, { preview: false, viewColumn: vscode.ViewColumn.One });
  const initialEdit = await editor.edit(edit => edit.insert(new vscode.Position(0, 0), "// unsaved parent snapshot\n"));
  assert.equal(initialEdit, true);
  const dirtySnapshot = document.getText();
  assert.equal(document.isDirty, true);
  await vscode.commands.executeCommand("workbench.action.files.setActiveEditorWriteableInSession");
  await vscode.window.showTextDocument(document, { preview: false, viewColumn: vscode.ViewColumn.Beside });

  await fs.writeFile(rules, support(0));
  await until(() => explorer.support.provideFileDecoration(uri)?.badge === "🔒" && !explorer.support.loading,
    "backend confirms locked support for the same dirty owner");
  const observations = {
    supportPolicyComesFromBackend: true,
    dirtyOwnerPreserved: document.getText() === dirtySnapshot,
    dirtyNativeViews: vscode.window.visibleTextEditors.filter(view => view.document === document).length,
    dirtyNativeTabs: vscode.window.tabGroups.all.flatMap(group => group.tabs).filter(tab =>
      tab.input instanceof vscode.TabInputText && tab.input.uri.toString() === uri.toString() && tab.isDirty).length,
  };
  assert.equal(observations.dirtyOwnerPreserved, true);
  assert.ok(observations.dirtyNativeViews >= 2, "support does not close unsaved split editors");
  observations.nativeTypingWithPriorWritable = await type(document, "// prior native writable remains effective\n");
  assert.equal(observations.nativeTypingWithPriorWritable, true);

  const protectedUri = await explorer.support.resolveUri(fixture.module);
  assert.equal(protectedUri.scheme, "eska-protected");
  const protectedDocument = await vscode.workspace.openTextDocument(protectedUri);
  observations.protectedReadsDisk = protectedDocument.getText() === original.toString("utf8");
  observations.protectedIncludesDirtySnapshot = protectedDocument.getText() === dirtySnapshot;
  observations.protectedFileSystemReadonly = vscode.workspace.fs.isWritableFileSystem(protectedUri.scheme) === false;
  await assert.rejects(vscode.workspace.fs.writeFile(protectedUri, Buffer.from("// direct provider write\n")));
  observations.protectedDirectWriteRejected = true;
  assert.equal(observations.protectedReadsDisk, true);
  assert.equal(observations.protectedIncludesDirtySnapshot, false);
  assert.equal(observations.protectedFileSystemReadonly, true);

  const reopened = await vscode.workspace.openTextDocument(uri);
  observations.reopenedNativeSharesDirtyOwner = reopened === document;
  observations.reopenedNativeTypingAllowed = await type(document, "// reopened native input\n");
  assert.equal(observations.reopenedNativeSharesDirtyOwner, true);
  assert.equal(observations.reopenedNativeTypingAllowed, true);

  // This intentionally does not apply a query or turn off support to grant an edit.
  // It releases the fixture's vendor rule only after all protection observations.
  const finalDirtyText = document.getText();
  await fs.writeFile(rules, support(1));
  await until(() => explorer.support.provideFileDecoration(uri)?.badge === "S" && !explorer.support.loading,
    "backend observes the fixture's restored support rule");
  observations.nativeDirtyTextRetainedAfterPolicyChange = document.getText() === finalDirtyText;
  await assert.rejects(vscode.workspace.fs.writeFile(protectedUri, Buffer.from("// policy changed\n")));
  observations.existingProtectedUriStaysReadonly = true;
  assert.equal(observations.nativeDirtyTextRetainedAfterPolicyChange, true);
  assert.equal(observations.existingProtectedUriStaysReadonly, true);
  assert.deepEqual(await fs.readFile(fixture.module), original);
  assert.equal((await fs.stat(fixture.module)).mode, beforeMode);
  await vscode.commands.executeCommand("eska.explorer.disconnect");
  await until(async () => {
    const current = JSON.parse(await fs.readFile(settings, "utf8"));
    delete current["files.readonlyInclude"];
    const expected = { ...beforeSettings };
    delete expected["files.readonlyInclude"];
    return JSON.stringify(current) === JSON.stringify(expected);
  }, "settings outside owned readonly rules remain unchanged");
  return { passed: true, suite: "query-owner-lock-existing-support-prototype", vscode: vscode.version,
    locale: vscode.env.language, observations, diskUnchanged: true, osPermissionsUnchanged: true,
    ownerLockAccepted: false, productionBslEditingEnabled: false };
}

/** Preserve a failed native assertion as a failed observation with its stack. */
exports.run = async function () {
  const fixture = JSON.parse(process.env.ESKA_HOST_FIXTURE);
  let result;
  try { result = await run(fixture); }
  catch (error) { result = { passed: false, error: String(error.stack ?? error) }; }
  await fs.writeFile(path.join(fixture.root, "host-result.json"), JSON.stringify(result));
};
