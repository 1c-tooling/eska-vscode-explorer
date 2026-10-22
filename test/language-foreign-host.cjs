const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const vscode = require("vscode");

/** The actual external client must answer from the fixture before its process can be considered running. */
async function until(predicate, label) {
  const end = Date.now() + 60000;
  while (Date.now() < end) { const value = await predicate(); if (value) return value; await new Promise(resolve => setTimeout(resolve, 60)); }
  throw new Error(label);
}

/** The frozen client's transport appends --stdio; exact executable identity excludes version/contract probes. */
async function foreignPids() {
  const expected = await fs.realpath(process.env.ESKA_BSL_BINARY), result = [];
  for (const pid of (await fs.readFile(`/proc/${process.pid}/task/${process.pid}/children`, "utf8")).trim().split(/\s+/).filter(Boolean)) {
    try {
      const args = (await fs.readFile(`/proc/${pid}/cmdline`, "utf8")).split("\0").filter(Boolean);
      if (args[1] === "--stdio" && await fs.realpath(args[0]) === expected) result.push(Number(pid));
    } catch (error) { if (error.code !== "ENOENT") throw error; }
  }
  return result;
}

/** A real third-party extension keeps serving while Explorer remains suspended and metadata stays connected. */
exports.run = async function () {
  const fixture = JSON.parse(process.env.ESKA_HOST_FIXTURE), foreign = vscode.extensions.getExtension("elishevkirill.bsl-analyzer-lsp");
  assert.ok(foreign);
  const initiallyActive = foreign.isActive;
  const { createLanguageSource } = await import("./language-fixture.mjs");
  const source = await createLanguageSource(fixture);
  const before = await fs.readFile(path.join(fixture.root, "bsl-analyzer.toml"), "utf8");
  const explorer = await vscode.extensions.all.find(value => value.packageJSON.name === "eska-explorer").activate();
  await until(() => explorer.connection.state.kind === "ready" && explorer.tooling.states.analyzer.phase === "suspended-conflict", "own client suspended");
  const document = await vscode.workspace.openTextDocument(vscode.Uri.file(source.file)); await vscode.window.showTextDocument(document);
  await foreign.activate();
  const hover = await until(async () => {
    const values = await vscode.commands.executeCommand("vscode.executeHoverProvider", document.uri, new vscode.Position(5, 15));
    return values?.some(value => value.contents.some(content => (typeof content === "string" ? content : content.value).includes("Проверка"))) && values;
  }, "real foreign hover");
  const pids = await until(async () => { const values = await foreignPids(); return values.length && values; }, "foreign LSP PID");
  const epoch = explorer.language.conflictEpoch;
  for (let i = 0; i < 3; i++) await vscode.commands.executeCommand("eska.explorer.restartLanguage");
  await explorer.language.stop();
  assert.equal(explorer.language.conflictEpoch, epoch); assert.equal(explorer.language.session, undefined);
  assert.equal(explorer.tooling.states.analyzer.phase, "suspended-conflict");
  for (const pid of pids) process.kill(pid, 0);
  assert.ok((await explorer.getChildren()).some(value => value.node));
  assert.equal(await fs.readFile(path.join(fixture.root, "bsl-analyzer.toml"), "utf8"), before);
  await fs.writeFile(path.join(fixture.root, "host-result.json"), JSON.stringify({ passed: true, suite: "language-foreign",
    vscode: vscode.version, extension: foreign.id, extension_version: foreign.packageJSON.version, initially_active: initiallyActive,
    foreign_hover: hover.length, own_session_absent: true, foreign_pids_preserved: pids,
    config_unchanged: true, shutdownPids: [...pids, explorer.connection.child.pid] }));
};
