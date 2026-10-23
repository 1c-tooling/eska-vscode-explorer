const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const vscode = require("vscode");

const readonly = "workbench.action.files.setActiveEditorReadonlyInSession";
const writable = "workbench.action.files.setActiveEditorWriteableInSession";
const reset = "workbench.action.files.resetActiveEditorReadonlyInSession";

/** Observe actual typing after the main-thread configuration and command operations finish. */
async function type(document, text) {
  const editor = await vscode.window.showTextDocument(document, { preview: false });
  const end = document.positionAt(document.getText().length);
  editor.selection = new vscode.Selection(end, end);
  const before = document.getText();
  await vscode.commands.executeCommand("type", { text });
  return document.getText() !== before;
}

/** Compare the public readonly probes without relying on any internal editor or configuration service. */
async function probes(document) {
  const editor = vscode.window.activeTextEditor;
  return { emptyEdit: await editor.edit(() => {}, { undoStopBefore: false, undoStopAfter: false }),
    permissions: (await vscode.workspace.fs.stat(document.uri)).permissions ?? null,
    writableFileSystem: vscode.workspace.fs.isWritableFileSystem(document.uri.scheme) };
}

/** Two writable native modes need different cleanup; neither Set/Reset nor Set/Writeable restores both. */
exports.run = async function () {
  const fixture = JSON.parse(process.env.ESKA_HOST_FIXTURE);
  const settings = path.join(fixture.root, ".vscode/settings.json");
  const beforeSettings = await fs.readFile(settings);
  const beforeDisk = await fs.readFile(fixture.module);
  const beforeMode = (await fs.stat(fixture.module)).mode;
  const document = await vscode.workspace.openTextDocument(vscode.Uri.file(fixture.module));
  await vscode.window.showTextDocument(document, { preview: false });
  const files = vscode.workspace.getConfiguration("files", document.uri);
  const previous = files.inspect("readonlyInclude").workspaceValue;
  let result;
  try {
    assert.equal(previous, undefined, "this fixture starts without a user readonly rule");
    await vscode.commands.executeCommand(reset);
    const inheritedProbes = await probes(document);
    await files.update("readonlyInclude", { "**/ObjectModule.bsl": true }, vscode.ConfigurationTarget.Workspace);
    const defaultHonorsRule = !await type(document, "// inherited mode blocks\n");
    assert.equal(defaultHonorsRule, true);
    await files.update("readonlyInclude", undefined, vscode.ConfigurationTarget.Workspace);

    await vscode.commands.executeCommand(writable);
    const grantedProbes = await probes(document);
    assert.deepEqual(inheritedProbes, grantedProbes);
    await files.update("readonlyInclude", { "**/ObjectModule.bsl": true }, vscode.ConfigurationTarget.Workspace);
    const explicitGrantOverridesRule = await type(document, "// explicit user grant allows\n");
    assert.equal(explicitGrantOverridesRule, true);
    await files.update("readonlyInclude", undefined, vscode.ConfigurationTarget.Workspace);
    await vscode.commands.executeCommand(readonly);
    await vscode.commands.executeCommand(reset);
    await files.update("readonlyInclude", { "**/ObjectModule.bsl": true }, vscode.ConfigurationTarget.Workspace);
    const resetLosesGrant = !await type(document, "// prior grant was lost by reset\n");
    assert.equal(resetLosesGrant, true);

    await files.update("readonlyInclude", undefined, vscode.ConfigurationTarget.Workspace);
    await vscode.commands.executeCommand(reset);
    await vscode.commands.executeCommand(readonly);
    await vscode.commands.executeCommand(writable);
    await files.update("readonlyInclude", { "**/ObjectModule.bsl": true }, vscode.ConfigurationTarget.Workspace);
    const forceWritableLosesInheritance = await type(document, "// inherited restriction was lost by Writeable\n");
    assert.equal(forceWritableLosesInheritance, true);
    result = { passed: true, suite: "query-lock-native-override-counterexamples", vscode: vscode.version,
      inheritedProbes, grantedProbes, publicReadonlyProbesEqual: true, defaultModeHonorsFutureConfig: defaultHonorsRule,
      explicitUserWritableOverridesFutureConfig: explicitGrantOverridesRule, resetLosesPriorWritable: resetLosesGrant,
      forceWritableLosesDefaultConfigInheritance: forceWritableLosesInheritance, productionBslEditingEnabled: false };
  } catch (error) { result = { passed: false, error: String(error.stack ?? error) }; }
  finally {
    await files.update("readonlyInclude", previous, vscode.ConfigurationTarget.Workspace);
    await vscode.commands.executeCommand(reset);
    await fs.writeFile(settings, beforeSettings);
  }
  assert.deepEqual(await fs.readFile(fixture.module), beforeDisk);
  assert.equal((await fs.stat(fixture.module)).mode, beforeMode);
  assert.deepEqual(await fs.readFile(settings), beforeSettings);
  result.sourceDiskUnchanged = true;
  result.osPermissionsUnchanged = true;
  result.privateSettingsRestoredExactly = true;
  await fs.writeFile(path.join(fixture.root, "host-result.json"), JSON.stringify(result));
};
