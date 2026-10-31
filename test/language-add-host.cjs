const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const vscode = require("vscode");
let stage = "bootstrap";

/** The normal CLI mutates the manifest while the native language client has a dirty buffer. */
async function until(predicate, label) {
  const deadline = Date.now() + 45000;
  while (Date.now() < deadline) {
    try { const value = await predicate(); if (value) return value; } catch { /* Providers can be cancelled during reconfiguration. */ }
    await new Promise(done => setTimeout(done, 50));
  }
  throw new Error(label);
}

async function run() {
  const fixture = JSON.parse(process.env.ESKA_HOST_FIXTURE);
  const explorer = await vscode.extensions.all.find(value => value.packageJSON.name === "eska-explorer").activate();
  await until(() => explorer.connection.state.kind === "ready", "metadata ready");
  const document = await vscode.workspace.openTextDocument(vscode.Uri.file(fixture.module));
  await vscode.window.showTextDocument(document);
  await until(() => explorer.tooling.states.analyzer.phase === "ready", "initial LSP ready");
  assert.equal(explorer.language.session.context.limited, true);
  const metadataPid = explorer.connection.child.pid, languagePid = explorer.language.session.owner.child.pid;
  const edit = new vscode.WorkspaceEdit();
  edit.insert(document.uri, document.positionAt(document.getText().length), "\n// unsaved before eska add\n");
  assert.equal(await vscode.workspace.applyEdit(edit), true);
  const dirty = document.getText();
  assert.equal(document.isDirty, true);
  stage = "add-live-library";
  const cli = promisify(execFile);
  const options = { cwd: fixture.root, env: { ...process.env, PATH: "", ESKA_VCS_BINARY: path.join(fixture.root, "missing-vcs") } };
  const result = JSON.parse((await cli(process.env.ESKA_TEST_BINARY, ["add", "ssl_3_1", "--format", "json"], options)).stdout);
  assert.equal(result.installed, false);
  assert.equal(result.project_changed, true);
  await until(() => explorer.tooling.states.analyzer.phase === "ready"
    && explorer.language.session?.context.sources.some(source => source.library?.name === "ssl_3_1")
    && explorer.language.session?.owner.child.pid !== languagePid, "add reconnects the selected library");
  assert.equal(explorer.language.session.context.limited, false);
  const column = document.lineAt(1).text.indexOf("Проверка") + 2;
  await until(async () => (await vscode.commands.executeCommand("vscode.executeDefinitionProvider", document.uri, new vscode.Position(1, column)))
    ?.some(value => (value.targetUri ?? value.uri).fsPath === fixture.library.first.definition), "dirty consumer resolves definition in added library");
  assert.equal(document.isDirty, true);
  assert.equal(document.getText(), dirty);
  assert.equal(explorer.connection.state.session.projects.length, 1);
  stage = "repeat-offline";
  const manifest = path.join(fixture.root, "eska.toml"), before = await fs.readFile(manifest);
  const repeated = JSON.parse((await cli(process.env.ESKA_TEST_BINARY, ["add", "ssl_3_1", "--format", "json"], options)).stdout);
  assert.equal(repeated.project_changed, false);
  assert.equal(repeated.catalog_changed, false);
  assert.deepEqual(await fs.readFile(manifest), before);
  assert.equal(document.getText(), dirty);
  await fs.writeFile(path.join(fixture.root, "host-result.json"), JSON.stringify({ passed: true, suite: "language-add", vscode: vscode.version,
    add_live: true, added_definition: true, dirty_preserved: true, offline_repeat: true, library_not_workspace_member: true,
    shutdownPids: [metadataPid, languagePid, explorer.connection.child.pid, explorer.language.session.owner.child.pid] }));
}

exports.run = async function () {
  try { await run(); }
  catch (error) {
    const fixture = JSON.parse(process.env.ESKA_HOST_FIXTURE);
    await fs.writeFile(path.join(fixture.root, "host-result.json"), JSON.stringify({ passed: false, stage, error: String(error), stack: error?.stack }));
    throw error;
  }
};
