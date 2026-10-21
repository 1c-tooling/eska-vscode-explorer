const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const vscode = require("vscode");

/** Native status checks wait for actual project and Analyzer probes, never a release response. */
async function until(predicate, label) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) { if (predicate()) return; await new Promise(resolve => setTimeout(resolve, 50)); }
  throw new Error(label);
}

/** Exercise two real components and their separate commands in an isolated editor profile. */
exports.run = async function () {
  const fixture = JSON.parse(process.env.ESKA_HOST_FIXTURE);
  const extension = vscode.extensions.all.find(value => value.packageJSON.name === "eska-explorer");
  const explorer = await extension.activate();
  await until(() => explorer.connection.state.kind === "ready", "project connected");
  await until(() => explorer.tooling.states.analyzer.phase === "verified", "Analyzer binary verified");
  const project = explorer.status, analyzer = explorer.tooling.analyzerStatus;
  assert.equal(project.text, `ESKA v${explorer.connection.state.version}`);
  assert.match(analyzer.text, /^BSL Analyzer v0\.3\.2 · /);
  assert.ok(project.tooltip.includes(explorer.connection.state.target.executable));
  assert.ok(analyzer.tooltip.includes(process.env.ESKA_TEST_ANALYZER_BINARY));
  assert.notEqual(project.id, analyzer.id);
  assert.equal(project.command, "eska.explorer.checkUpdates");
  assert.equal(analyzer.command, "eska.explorer.checkAnalyzerUpdates");
  const check = explorer.tooling.check, calls = [];
  explorer.tooling.check = async (kind, manual = true) => { calls.push([kind, manual]); };
  try { await vscode.commands.executeCommand(project.command); await vscode.commands.executeCommand(analyzer.command); }
  finally { explorer.tooling.check = check; }
  assert.deepEqual(calls, [["project", true], ["analyzer", true]]);
  const config = vscode.workspace.getConfiguration("eska.explorer");
  assert.equal(config.get("checkForUpdates"), false);
  assert.equal(config.get("checkForAnalyzerUpdates"), false);
  const readyText = project.text;
  explorer.tooling.analyzerState("error", "injected-language-failure");
  assert.equal(project.text, readyText);
  assert.ok((await explorer.getChildren()).some(entry => entry.node), "language failure leaves metadata available");
  explorer.tooling.analyzerState("suspended", "injected-conflict");
  await vscode.commands.executeCommand("eska.explorer.disconnect");
  assert.match(project.text, /^ESKA · /);
  assert.ok(!project.text.includes(explorer.tooling.states.analyzer.info.version));
  assert.match(analyzer.text, /^BSL Analyzer v0\.3\.2 · /);
  assert.equal(explorer.tooling.states.analyzer.phase, "suspended");
  await fs.writeFile(path.join(fixture.root, "host-result.json"), JSON.stringify({ passed: true, suite: "tool-status",
    vscode: vscode.version, node: process.versions.node, project: readyText, analyzer: analyzer.text,
    tooltip: analyzer.tooltip, commands: calls }));
};
