const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const vscode = require("vscode");

/** Reload availability is authoritative: a disabled extension is absent, then appears again when re-enabled. */
async function until(predicate, label) {
  const end = Date.now() + 30000;
  while (Date.now() < end) { if (predicate()) return; await new Promise(resolve => setTimeout(resolve, 40)); }
  throw new Error(typeof label === "function" ? label() : label);
}

/** Three real host launches reuse one private profile: enabled inactive, disabled, then enabled again. */
exports.run = async function () {
  const fixture = JSON.parse(process.env.ESKA_HOST_FIXTURE), run = Number(process.env.ESKA_HOST_RUN);
  const file = path.join(fixture.source, "CommonModules", "Обмен", "Ext", "Module.bsl");
  assert.ok(process.env.ESKA_HOST_CONFLICT_RELOAD, "the runner prepares the source before editor activation");
  const foreign = vscode.extensions.getExtension("elishevkirill.bsl-analyzer-lsp");
  assert.equal(!!foreign, run !== 1);
  if (foreign) assert.equal(foreign.isActive, false);
  const explorer = await vscode.extensions.all.find(value => value.packageJSON.name === "eska-explorer").activate();
  await until(() => explorer.connection.state.kind === "ready", () => `metadata ready: ${JSON.stringify(explorer.connection.state)}`);
  const document = await vscode.workspace.openTextDocument(vscode.Uri.file(file));
  assert.equal(document.languageId, "bsl"); await vscode.window.showTextDocument(document);
  const expected = run === 1 ? "ready" : "suspended-conflict";
  await until(() => explorer.tooling.states.analyzer.phase === expected, "state after host reload");
  const pids = [explorer.connection.child.pid];
  if (run === 1) pids.push(explorer.language.session.owner.child.pid);
  else assert.equal(explorer.language.session, undefined);
  assert.ok((await explorer.getChildren()).some(value => value.node));
  await fs.writeFile(path.join(fixture.root, "host-result.json"), JSON.stringify({ passed: true, suite: "language-conflict-reload",
    vscode: vscode.version, run, available: !!foreign, state: expected, registry_fixture: true, shutdownPids: pids }));
};
