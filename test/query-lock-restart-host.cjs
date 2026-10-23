const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const vscode = require("vscode");

/** Observe native typing without depending on a private editor or workbench object. */
async function type(document, text) {
  const editor = await vscode.window.showTextDocument(document, { preview: false });
  const end = document.positionAt(document.getText().length);
  editor.selection = new vscode.Selection(end, end);
  const before = document.getText();
  await vscode.commands.executeCommand("type", { text });
  return document.getText() !== before;
}

/** Compare an actual extension-host restart with a later ordinary editor-window restart. */
exports.run = async function () {
  const fixture = JSON.parse(process.env.ESKA_HOST_FIXTURE);
  const statePath = path.join(fixture.root, "lock-restart-state.json");
  const resultPath = path.join(fixture.root, "host-result.json");
  try {
    const document = await vscode.workspace.openTextDocument(vscode.Uri.file(fixture.module));
    await vscode.window.showTextDocument(document, { preview: false });
    if (process.env.ESKA_HOST_RUN === "0") {
      let state;
      try { state = JSON.parse(await fs.readFile(statePath, "utf8")); }
      catch (error) { if (error.code !== "ENOENT") throw error; }
      if (!state) {
        const disk = (await fs.readFile(fixture.module)).toString("base64");
        const editor = vscode.window.activeTextEditor;
        assert.equal(await editor.edit(edit => edit.insert(document.positionAt(document.getText().length), "// unsaved before restart 😀\n")), true);
        await vscode.commands.executeCommand("workbench.action.files.setActiveEditorReadonlyInSession");
        assert.equal(await type(document, "// blocked before restart\n"), false);
        await fs.writeFile(statePath, JSON.stringify({ pid: process.pid, owner: document.getText(), disk }));
        await vscode.commands.executeCommand("workbench.action.restartExtensionHost");
        // The next startup activation reports the result. This old host must never close its window.
        await new Promise(() => {});
        return;
      }
      assert.notEqual(process.pid, state.pid, "a real new extension-host process is required");
      assert.equal(document.getText(), state.owner, "the native dirty owner survived the host restart");
      const stillLocked = !await type(document, "// remains blocked after host restart\n");
      await vscode.commands.executeCommand("workbench.action.files.resetActiveEditorReadonlyInSession");
      assert.equal((await fs.readFile(fixture.module)).toString("base64"), state.disk);
      await fs.writeFile(resultPath, JSON.stringify({ passed: true, suite: "query-lock-extension-host-restart", vscode: vscode.version,
        oldPid: state.pid, newPid: process.pid, dirtyOwnerRetained: true, nativeSessionLockSurvivesHostRestart: stillLocked,
        explicitCleanupIssued: true, sourceDiskUnchanged: true, productionBslEditingEnabled: false }));
      return;
    }
    const state = JSON.parse(await fs.readFile(statePath, "utf8"));
    const retained = document.getText() === state.owner;
    const writable = await type(document, "// editable after a fresh window\n");
    assert.equal((await fs.readFile(fixture.module)).toString("base64"), state.disk);
    await fs.writeFile(resultPath, JSON.stringify({ passed: true, suite: "query-lock-window-restart", vscode: vscode.version,
      nativeHotExitRetainedOwner: retained, freshWindowWritableAfterCleanup: writable, sourceDiskUnchanged: true, productionBslEditingEnabled: false }));
  } catch (error) {
    await fs.writeFile(resultPath, JSON.stringify({ passed: false, error: String(error.stack ?? error) }));
  }
};
