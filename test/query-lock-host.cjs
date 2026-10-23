const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const vscode = require("vscode");

const readonly = "workbench.action.files.setActiveEditorReadonlyInSession";
const writable = "workbench.action.files.setActiveEditorWriteableInSession";
const reset = "workbench.action.files.resetActiveEditorReadonlyInSession";
const toggle = "workbench.action.files.toggleActiveEditorReadonlyInSession";

/** Send native typing at the end of the active editor and observe the actual shared document. */
async function type(document, text) {
  const editor = vscode.window.activeTextEditor;
  assert.equal(editor.document, document);
  const end = document.positionAt(document.getText().length);
  editor.selection = new vscode.Selection(end, end);
  const before = document.getText();
  await vscode.commands.executeCommand("type", { text });
  return document.getText() !== before;
}

/** Probe session actions, split views and a snapshot provider without enabling a BSL editing feature. */
async function run(fixture) {
  const uri = vscode.Uri.file(fixture.module);
  const beforeDisk = await fs.readFile(fixture.module);
  const beforeMode = (await fs.stat(fixture.module)).mode;
  const settings = path.join(fixture.root, ".vscode/settings.json");
  const beforeSettings = await fs.readFile(settings);
  const document = await vscode.workspace.openTextDocument(uri);
  let editor = await vscode.window.showTextDocument(document, { preview: false });
  const observations = {};
  observations.writableEmptyEdit = await editor.edit(() => {}, { undoStopBefore: false, undoStopAfter: false });
  const response = await vscode.commands.executeCommand(readonly);
  observations.readonlyCommandReturns = typeof response;
  observations.cleanTypingBlocked = !await type(document, "// blocked clean\n");
  observations.readonlyEmptyEdit = await editor.edit(() => {}, { undoStopBefore: false, undoStopAfter: false });
  const noopVersion = document.version;
  observations.readonlyEmptyInsert = await editor.edit(edit => edit.insert(document.positionAt(0), ""), { undoStopBefore: false, undoStopAfter: false });
  observations.emptyInsertChangedVersion = document.version !== noopVersion;
  observations.readonlyNativeFilePermissions = (await vscode.workspace.fs.stat(uri)).permissions ?? null;
  observations.readonlyNativeFileSystemWritable = vscode.workspace.fs.isWritableFileSystem(uri.scheme);
  observations.readonlyCommands = (await vscode.commands.getCommands(true)).filter(command => /readonly|writeableinsession/i.test(command));
  await vscode.commands.executeCommand(writable);
  assert.equal(await editor.edit(edit => edit.insert(document.positionAt(document.getText().length), "// previous unsaved owner edit 😀\n")), true);
  const dirtySnapshot = document.getText();
  assert.equal(document.isDirty, true);
  await vscode.commands.executeCommand(readonly);
  observations.dirtyTypingBlocked = !await type(document, "// blocked dirty\n");
  await vscode.window.showTextDocument(document, { preview: false, viewColumn: vscode.ViewColumn.Beside });
  observations.splitTypingBlocked = !await type(document, "// blocked split\n");
  observations.splitViews = vscode.window.tabGroups.all.flatMap(group => group.tabs).filter(tab =>
    tab.input instanceof vscode.TabInputText && tab.input.uri.toString() === uri.toString()).length;
  const reopened = await vscode.workspace.openTextDocument(uri);
  observations.nativeReopenSharesDocument = reopened === document;
  await vscode.window.showTextDocument(reopened, { preview: false, viewColumn: vscode.ViewColumn.One });
  observations.reopenedTypingBlocked = !await type(document, "// blocked reopened\n");
  assert.equal(document.getText(), dirtySnapshot);
  const otherPath = path.join(fixture.root, "other-owner.txt");
  await fs.writeFile(otherPath, "other file\n");
  const other = await vscode.workspace.openTextDocument(vscode.Uri.file(otherPath));
  await vscode.window.showTextDocument(other, { preview: false });
  observations.otherOwnerRemainsWritable = await type(other, "still editable\n");
  editor = await vscode.window.showTextDocument(document, { preview: false, viewColumn: vscode.ViewColumn.One });
  observations.ownerStillLockedAfterOtherFile = !await type(document, "// owner remains blocked\n");
  await vscode.commands.executeCommand(writable);
  observations.builtinWritableBypassesSessionLock = await type(document, "// unlocked by builtin command\n");
  await vscode.commands.executeCommand("undo");
  observations.undoRestoresDirtySnapshot = document.getText() === dirtySnapshot;
  await vscode.commands.executeCommand(readonly);
  const beforeUndo = document.getText();
  await vscode.commands.executeCommand("undo");
  observations.undoWhileReadonlyChangesOwner = document.getText() !== beforeUndo;
  if (observations.undoWhileReadonlyChangesOwner) await vscode.commands.executeCommand("redo");

  const registrations = [];
  let intercepted = 0;
  try {
    // This probes command registration only. It is not a production interception policy.
    for (const command of [writable, reset, toggle]) registrations.push(vscode.commands.registerCommand(command, () => { intercepted++; }));
    observations.builtinOverrideRegistration = true;
    for (const command of [writable, reset, toggle]) await vscode.commands.executeCommand(command);
    observations.builtinOverrideCalls = intercepted;
    observations.overrideBlocksNativeTyping = !await type(document, "// intercepted unlock\n");
  } catch (error) {
    observations.builtinOverrideRegistration = false;
    observations.builtinOverrideError = String(error.message ?? error);
  } finally { for (const registration of registrations) registration.dispose(); }

  // A previous user restriction and an extension's restriction occupy the same native resource slot.
  await vscode.commands.executeCommand(readonly);
  await vscode.commands.executeCommand(readonly);
  await vscode.commands.executeCommand(reset);
  observations.resetClearsPreexistingSessionReadonly = await type(document, "// prior user lock was cleared\n");
  await vscode.commands.executeCommand("undo");

  const provider = vscode.workspace.registerTextDocumentContentProvider("eska-lock-probe", {
    provideTextDocumentContent: () => dirtySnapshot,
  });
  try {
    const snapshot = await vscode.workspace.openTextDocument(vscode.Uri.from({ scheme: "eska-lock-probe", path: "/owner.bsl" }));
    await vscode.window.showTextDocument(snapshot, { preview: false });
    observations.snapshotIncludesDirtyOwner = snapshot.getText() === dirtySnapshot;
    observations.snapshotTypingBlocked = !await type(snapshot, "// blocked snapshot\n");
    editor = await vscode.window.showTextDocument(document, { preview: false });
    observations.originalFileEditableBesideSnapshot = await type(document, "// original remains editable\n");
    await vscode.commands.executeCommand("undo");
  } finally { provider.dispose(); }

  await vscode.commands.executeCommand(readonly);
  const beforeWorkspaceEdit = document.getText();
  const edit = new vscode.WorkspaceEdit();
  edit.insert(uri, document.positionAt(document.getText().length), "// independent WorkspaceEdit\n");
  observations.workspaceEditAppliedWhileReadonly = await vscode.workspace.applyEdit(edit);
  observations.workspaceEditChangesOwner = document.getText() !== beforeWorkspaceEdit;
  await vscode.commands.executeCommand(reset);
  assert.deepEqual(await fs.readFile(fixture.module), beforeDisk);
  assert.equal((await fs.stat(fixture.module)).mode, beforeMode);
  assert.deepEqual(await fs.readFile(settings), beforeSettings);
  return { passed: true, suite: "query-owner-lock-public-api-prototype", vscode: vscode.version, locale: vscode.env.language,
    observations, diskUnchanged: true, osPermissionsUnchanged: true, settingsUnchanged: true, productionBslEditingEnabled: false };
}

/** A native assertion failure remains a failed prototype with its exact stack, never a successful lock claim. */
exports.run = async function () {
  const fixture = JSON.parse(process.env.ESKA_HOST_FIXTURE);
  let result;
  try { result = await run(fixture); }
  catch (error) { result = { passed: false, error: String(error.stack ?? error) }; }
  await fs.writeFile(path.join(fixture.root, "host-result.json"), JSON.stringify(result));
};
