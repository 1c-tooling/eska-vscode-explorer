const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const vscode = require("vscode");
let stage = "bootstrap";

/** Observe native provider results and reconfiguration without substituting an analyzer. */
async function until(predicate, label) {
  const deadline = Date.now() + 45000;
  while (Date.now() < deadline) {
    try { const result = await predicate(); if (result) return result; } catch { /* A restart cancels in-flight providers. */ }
    await new Promise(done => setTimeout(done, 50));
  }
  throw new Error(label);
}

/** An EPF resolves an exported base function and regenerates policy from its single owning manifest. */
async function run() {
  const fixture = JSON.parse(process.env.ESKA_HOST_FIXTURE);
  const explorer = await vscode.extensions.all.find(value => value.packageJSON.name === "eska-explorer").activate();
  await until(() => explorer.connection.state.kind === "ready", "metadata ready");
  const document = await vscode.workspace.openTextDocument(vscode.Uri.file(fixture.module));
  await vscode.window.showTextDocument(document);
  stage = "reference-language";
  await until(() => explorer.tooling.states.analyzer.phase === "ready", "reference LSP ready");
  assert.equal(explorer.connection.state.session.projects.length, 1);
  assert.equal(explorer.language.session.context.sources.length, 2);
  assert.equal(explorer.language.session.context.limited, false);
  const metadataPid = explorer.connection.child.pid, firstPid = explorer.language.session.owner.child.pid;
  stage = "external-definition";
  const character = document.lineAt(1).text.indexOf("Проверка") + 2;
  await until(async () => (await vscode.commands.executeCommand("vscode.executeDefinitionProvider", document.uri, new vscode.Position(1, character)))
    ?.some(value => (value.targetUri ?? value.uri).fsPath === fixture.reference.definition), "definition resolves in reference BSP base");
  const config = path.join(fixture.root, "bsl-analyzer.toml");
  assert.match(await fs.readFile(config, "utf8"), /LineLength = false/);
  const fingerprint = explorer.language.session.configuration.fingerprint;
  stage = "policy-regeneration";
  await fs.appendFile(path.join(fixture.root, "eska.toml"), "\n[tools.bsl-analyzer.formatting]\nindent_size=2\n");
  await until(async () => explorer.tooling.states.analyzer.phase === "ready"
    && explorer.language.session?.configuration.fingerprint !== fingerprint
    && /indent_size = 2/.test(await fs.readFile(config, "utf8")), "eska.toml change regenerates analyzer config");
  assert.match(await fs.readFile(config, "utf8"), /LineLength = false/);
  for (const file of ["eska.toml", "bsl-analyzer.toml", ".eska"]) {
    await assert.rejects(fs.access(path.join(fixture.reference.root, file)), { code: "ENOENT" });
  }
  await fs.writeFile(path.join(fixture.root, "host-result.json"), JSON.stringify({ passed: true, suite: "language-reference",
    vscode: vscode.version, external_definition: true, policy_regenerated: true, line_length_preserved: true,
    shutdownPids: [metadataPid, firstPid, explorer.connection.child.pid, explorer.language.session.owner.child.pid] }));
}

/** Keep the failed transition available after the disposable profile is removed. */
exports.run = async function () {
  try { await run(); }
  catch (error) {
    const fixture = JSON.parse(process.env.ESKA_HOST_FIXTURE);
    await fs.writeFile(path.join(fixture.root, "host-result.json"), JSON.stringify({ passed: false, stage, error: String(error), stack: error?.stack }));
    throw error;
  }
};
