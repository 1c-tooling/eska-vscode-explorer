const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const vscode = require("vscode");

/** Await observable editor/backend state rather than guessing installer or language startup duration. */
async function until(predicate, label) {
  const deadline = Date.now() + 45000;
  while (Date.now() < deadline) { if (predicate()) return; await new Promise(resolve => setTimeout(resolve, 50)); }
  throw new Error(label);
}

/** Exercise an approved update of an explicitly supplied disposable cargo-dist copy through the installed VSIX. */
exports.run = async function () {
  const fixture = JSON.parse(process.env.ESKA_HOST_FIXTURE), root = process.env.ESKA_HOST_BUNDLE_ROOT;
  assert.ok(root && path.isAbsolute(root));
  const relative = path.relative(process.env.ESKA_TEST_ROOT, root);
  assert.ok(relative && !path.isAbsolute(relative) && !relative.startsWith(".."), "only an owned playground installation may be updated");
  const executable = path.join(root, "bin", process.platform === "win32" ? "eska-project.exe" : "eska-project");
  assert.equal(process.env.ESKA_TEST_BINARY, executable);
  const extension = vscode.extensions.all.find(value => value.packageJSON.name === "eska-explorer");
  const explorer = await extension.activate();
  await until(() => explorer.connection.state.kind === "ready", "old project connected");
  assert.equal(explorer.connection.state.target.executable, executable);
  assert.equal(explorer.connection.state.version, "0.15.2");
  explorer.tooling.root = root;
  const text = explorer.tooling.text, offers = [];
  explorer.tooling.text = function (key, ...values) { const result = text.call(this, key, ...values); if (key === "toolBundleUpdateOffer" || key === "toolCurrent") offers.push(result); return result; };
  try {
    const document = await vscode.workspace.openTextDocument(vscode.Uri.file(fixture.languageSource.file));
    await vscode.window.showTextDocument(document);
    await until(() => explorer.tooling.states.analyzer.phase === "error", "old Analyzer contract rejected");
    const mismatch = explorer.tooling.states.analyzer.detail;
    assert.match(mismatch, /Check for ESKA Updates/);
    assert.ok(!mismatch.includes("protocolInvalid"));
    await vscode.commands.executeCommand("notifications.clearAll");
    const updating = vscode.commands.executeCommand("eska.explorer.checkUpdates");
    await until(() => offers.length > 0, "bundle update offered");
    await vscode.commands.executeCommand("notifications.focusToasts");
    await vscode.commands.executeCommand("notification.acceptPrimaryAction");
    await updating;
    await until(() => explorer.connection.state.kind === "ready" && explorer.connection.state.version === "0.16.0", "updated project reconnected");
    await until(() => explorer.tooling.states.analyzer.phase === "ready", "language service recovered after the bundle update");
    assert.ok(offers.some(text => text.includes("entire ESKA bundle")));
    assert.equal(explorer.language.session.client.initializeResult.serverInfo.version, "0.4.0");
    const receipt = JSON.parse(await fs.readFile(path.join(process.env.AXOUPDATER_CONFIG_PATH, "eska-receipt.json"), "utf8"));
    assert.equal(receipt.version, "0.16.0"); assert.equal(receipt.install_prefix, path.join(root, "bin"));
    await assert.rejects(fs.access(path.join(root, "components/eska-project.json")), { code: "ENOENT" });
    await vscode.commands.executeCommand("eska.explorer.checkUpdates");
    assert.ok(offers.at(-1).includes("0.16.0"));
    await fs.writeFile(path.join(fixture.root, "host-result.json"), JSON.stringify({ passed: true, suite: "bundle-update", vscode: vscode.version,
      node: process.versions.node, from: "0.15.2", to: explorer.connection.state.version, analyzer: explorer.language.session.client.initializeResult.serverInfo.version,
      offers, mismatch, receiptVersion: receipt.version }));
  } finally { explorer.tooling.text = text; }
};
