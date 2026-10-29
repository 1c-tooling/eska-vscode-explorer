const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const vscode = require("vscode");

/** Wait for an actual support snapshot rather than a rendered placeholder. */
async function until(predicate, label) {
  const deadline = Date.now() + 15000;
  while (!predicate()) {
    assert.ok(Date.now() < deadline, label);
    await new Promise(resolve => setTimeout(resolve, 40));
  }
}

/** A transient object read and a cancelled file debounce both recover within the original session. */
exports.run = async function () {
  const fixture = JSON.parse(process.env.ESKA_HOST_FIXTURE);
  await vscode.workspace.getConfiguration("eska.explorer").update("executable", process.env.ESKA_TEST_BINARY, vscode.ConfigurationTarget.Workspace);
  const explorer = await vscode.extensions.all.find(value => value.packageJSON.name === "eska-explorer").activate();
  await vscode.commands.executeCommand("eska.explorer.disconnect");
  await vscode.commands.executeCommand("eska.explorer.connect");
  assert.equal(explorer.connection.state.kind, "ready");
  assert.equal(explorer.connection.state.supportObjects, true);
  const session = explorer.connection.state.session.sessionId;
  const root = (await explorer.getChildren()).find(row => row.node);
  await until(() => !!explorer.support.object(root)?.uuid, "initial support loaded");
  const request = explorer.tree.request.bind(explorer.tree);
  let attempts = 0;
  explorer.tree.request = async (...args) => {
    if (args[1] === "metadata/supportObjects" && ++attempts === 1) throw new Error("temporary support transport failure");
    return request(...args);
  };
  try {
    // Force a policy refresh with the same source bytes, as after an explicit invalidation.
    explorer.support.requested = undefined;
    explorer.support.invalidate();
    await until(() => {
      const policy = explorer.support.object(root);
      return attempts >= 2 && !!policy?.uuid;
    }, "support retried without restarting");
  } finally { explorer.tree.request = request; }
  explorer.support.queueFile(fixture.module);
  assert.equal(explorer.support.requestedFiles.has(fixture.module), true);
  explorer.support.requested = undefined;
  explorer.support.invalidate();
  assert.equal(explorer.support.requestedFiles.has(fixture.module), false, "cancelled debounce releases pending paths");
  explorer.support.queueFile(fixture.module);
  await until(() => explorer.support.fileIndex.has(vscode.Uri.file(fixture.module).toString()), "file policy loaded after cancellation");
  assert.equal(explorer.connection.state.session.sessionId, session);
  await vscode.commands.executeCommand("eska.explorer.disconnect");
  await fs.writeFile(path.join(fixture.root, "host-result.json"), JSON.stringify({ passed: true,
    suite: "support-retry", vscode: vscode.version, locale: vscode.env.language, attempts }));
};
