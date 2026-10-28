const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const vscode = require("vscode");
const ID = "elishevkirill.bsl-analyzer-lsp";

/** A registry event or process exit must be observed, without guessing from an install command's return value. */
async function until(predicate, label) {
  const end = Date.now() + 30000;
  while (Date.now() < end) { if (await predicate()) return; await new Promise(resolve => setTimeout(resolve, 40)); }
  throw new Error(label);
}
/** Inspect only a process created by this profile. */
function exited(pid) { try { process.kill(pid, 0); return false; } catch (error) { if (error.code === "ESRCH") return true; throw error; } }

/** Public install/uninstall events cancel a real validator, stop an owned LSP, and resume after removal. */
exports.run = async function () {
  const fixture = JSON.parse(process.env.ESKA_HOST_FIXTURE), python = process.env.ESKA_TEST_PYTHON;
  assert.ok(python && path.isAbsolute(python));
  const { createLanguageSource } = await import("./language-fixture.mjs");
  const source = await createLanguageSource(fixture);
  const explorer = await vscode.extensions.all.find(value => value.packageJSON.name === "eska-explorer").activate();
  await until(() => explorer.connection.state.kind === "ready", "metadata ready");
  const initial = vscode.extensions.getExtension(ID);
  if (initial) {
    assert.equal(initial.isActive, false, "the registry fixture has no language/startup activation");
    await until(() => explorer.tooling.states.analyzer.phase === "suspended-conflict", "initial inactive conflict");
    assert.equal(explorer.language.session, undefined);
    await assert.rejects(fs.access(path.join(fixture.root, "bsl-analyzer.toml")));
    await vscode.commands.executeCommand("workbench.extensions.uninstallExtension", ID);
    await until(() => !vscode.extensions.getExtension(ID), "inactive extension removed");
  }
  const wrapper = path.join(fixture.root, "controlled-analyzer"), marker = path.join(fixture.root, "validator-pid");
  await fs.writeFile(wrapper, `#!${python}\nimport os,sys,time\nfrom pathlib import Path\nif len(sys.argv)>1 and sys.argv[1]=='check-config':\n Path(${JSON.stringify(marker)}).write_text(str(os.getpid()))\n while True: time.sleep(.1)\nos.execv(${JSON.stringify(process.env.ESKA_TEST_ANALYZER_BINARY)},[${JSON.stringify(process.env.ESKA_TEST_ANALYZER_BINARY)},*sys.argv[1:]])\n`, { mode: 0o755 });
  const config = vscode.workspace.getConfiguration("eska.explorer");
  await config.update("analyzerExecutable", wrapper, vscode.ConfigurationTarget.Workspace);
  const document = await vscode.workspace.openTextDocument(vscode.Uri.file(source.file));
  await vscode.window.showTextDocument(document);
  await until(() => fs.access(marker).then(() => true, () => false), "real validator running");
  const validatorPid = Number(await fs.readFile(marker, "utf8"));
  await vscode.commands.executeCommand("workbench.extensions.installExtension", vscode.Uri.file(process.env.ESKA_HOST_CONFLICT_VSIX));
  await until(() => explorer.tooling.states.analyzer.phase === "suspended-conflict" && exited(validatorPid), "install cancels validator");
  await explorer.language.queue;
  await assert.rejects(fs.access(path.join(fixture.root, "bsl-analyzer.toml")));
  const epoch = explorer.language.conflictEpoch;
  for (let i = 0; i < 3; i++) await vscode.commands.executeCommand("eska.explorer.restartLanguage");
  assert.equal(explorer.language.conflictEpoch, epoch);
  assert.equal(explorer.language.session, undefined);
  assert.ok((await explorer.getChildren()).some(value => value.node));
  await config.update("analyzerExecutable", process.env.ESKA_TEST_ANALYZER_BINARY, vscode.ConfigurationTarget.Workspace);
  await vscode.commands.executeCommand("workbench.extensions.uninstallExtension", ID);
  await until(() => !vscode.extensions.getExtension(ID) && explorer.tooling.states.analyzer.phase === "ready", "removal resumes own client");
  const firstPid = explorer.language.session.owner.child.pid;
  await vscode.commands.executeCommand("workbench.extensions.installExtension", vscode.Uri.file(process.env.ESKA_HOST_CONFLICT_VSIX));
  await until(() => explorer.tooling.states.analyzer.phase === "suspended-conflict" && exited(firstPid), "new conflict stops active own client");
  await explorer.language.queue;
  assert.equal(explorer.language.session, undefined);
  const start = { value: fixture.root, encoding: "utf-8" };
  const lease = await explorer.connection.analyzerRequest("analyzer/acquire", { start });
  await explorer.connection.analyzerRequest("analyzer/release", { leaseId: lease.leaseId });
  assert.ok(explorer.tooling.tooltip("analyzer").includes(ID));
  assert.ok(explorer.status.tooltip.includes("ESKA Explorer"));
  await vscode.commands.executeCommand("workbench.extensions.uninstallExtension", ID);
  await until(() => !vscode.extensions.getExtension(ID) && explorer.tooling.states.analyzer.phase === "ready", "second removal resumes own client");
  const lastPid = explorer.language.session.owner.child.pid;
  assert.notEqual(lastPid, firstPid);
  await fs.writeFile(path.join(fixture.root, "host-result.json"), JSON.stringify({ passed: true, suite: "language-conflict",
    vscode: vscode.version, initially_inactive: !!initial, registry_fixture: true, real_validator_cancelled: true, config_not_published_on_cancel: true,
    active_own_client_reaped: true, lease_released: true, resumed_after_removal: true,
    shutdownPids: [validatorPid, firstPid, lastPid, explorer.connection.child.pid] }));
};
