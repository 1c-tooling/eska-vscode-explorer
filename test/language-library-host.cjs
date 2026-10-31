const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const vscode = require("vscode");
let stage = "bootstrap";

/** Native providers may cancel during a legitimate generation replacement. */
async function until(predicate, label) {
  const deadline = Date.now() + 45000;
  while (Date.now() < deadline) {
    try { const value = await predicate(); if (value) return value; } catch { /* Await the new generation. */ }
    await new Promise(done => setTimeout(done, 50));
  }
  throw new Error(label);
}

/** Exercise the installed analyzer, native file observers and dirty-buffer synchronization together. */
async function run() {
  const fixture = JSON.parse(process.env.ESKA_HOST_FIXTURE), library = fixture.library;
  const explorer = await vscode.extensions.all.find(value => value.packageJSON.name === "eska-explorer").activate();
  await until(() => explorer.connection.state.kind === "ready", "metadata ready");
  const document = await vscode.workspace.openTextDocument(vscode.Uri.file(fixture.module));
  const editor = await vscode.window.showTextDocument(document);
  const original = document.getText(), manifest = await fs.readFile(path.join(fixture.root, "eska.toml"));
  const config = path.join(fixture.root, "bsl-analyzer.toml"), pids = new Set([explorer.connection.child.pid]);
  const catalog = base => "[build]\nrunner='host'\n[libraries.ssl_3_1]\nsource=" + JSON.stringify(path.relative(library.configDir, base.source)) + "\n[libraries.other]\nsource='unused/missing'\n";
  if (["1", "directory"].includes(process.env.ESKA_HOST_LIBRARY_MISSING)) {
    stage = "missing-catalog";
    await until(() => explorer.tooling.states.analyzer.phase === "error" && explorer.language.libraryObservation, "missing entry keeps recovery observer");
    assert.ok(explorer.tooling.states.analyzer.detail.includes("ssl_3_1"));
    await fs.mkdir(library.configDir, { recursive: true });
    await fs.writeFile(library.config, catalog(library.first));
  }
  stage = "first-library";
  await until(() => explorer.tooling.states.analyzer.phase === "ready", "named library LSP ready");
  const metadata = explorer.connection.child.pid, first = explorer.language.session.owner.child.pid;
  pids.add(first);
  assert.equal(explorer.connection.state.session.projects.length, 1);
  assert.equal(explorer.language.session.context.sources.length, 2);
  assert.equal(explorer.language.session.context.sources[0].library.name, "ssl_3_1");
  const character = document.lineAt(1).text.indexOf("Проверка") + 2;
  const definition = async base => (await vscode.commands.executeCommand("vscode.executeDefinitionProvider", document.uri, new vscode.Position(1, character)))
    ?.some(value => (value.targetUri ?? value.uri).fsPath === base.definition);
  await until(() => definition(library.first), "definition in first named library");
  assert.match(await fs.readFile(config, "utf8"), /LineLength = false/);

  stage = "dirty-diagnostic";
  const dirty = original + "\n// unsaved T145 😀\nФункция Сломано(\n";
  assert.equal(await editor.edit(edit => edit.insert(document.positionAt(original.length), dirty.slice(original.length))), true);
  await until(() => vscode.languages.getDiagnostics(document.uri).length > 0, "real diagnostics for unsaved BSL");
  assert.equal(document.isDirty, true); assert.equal(await fs.readFile(fixture.module, "utf8"), original);

  stage = "unrelated-entry";
  const model = explorer.language.modelRevision;
  await fs.writeFile(library.config, catalog(library.first));
  await until(() => explorer.language.modelRevision > model && !explorer.language.configurationPending
    && explorer.tooling.states.analyzer.phase === "ready", "unrelated catalog entry checked");
  assert.equal(explorer.language.session.owner.child.pid, first);

  stage = "selected-path";
  await fs.writeFile(library.config, catalog(library.second));
  await until(() => explorer.tooling.states.analyzer.phase === "ready" && explorer.language.session?.owner.child.pid !== first, "path change replaces LSP");
  const second = explorer.language.session.owner.child.pid; pids.add(second);
  assert.equal(explorer.connection.child.pid, metadata);
  assert.equal(explorer.language.session.context.sources[0].source, library.second.source);
  assert.equal(document.getText(), dirty); assert.equal(document.isDirty, true);
  await until(() => definition(library.second), "definition follows selected library path");
  await until(() => vscode.languages.getDiagnostics(document.uri).length > 0, "dirty diagnostics restored in replacement LSP");
  assert.match(await fs.readFile(config, "utf8"), /LineLength = false/);

  stage = "invalid-and-recover";
  await fs.writeFile(library.config, "[libraries.ssl_3_1]\nsource=''\n");
  await until(() => explorer.tooling.states.analyzer.phase === "error" && !explorer.language.session, "invalid entry stops old LSP");
  assert.ok(explorer.tooling.states.analyzer.detail.includes(library.config));
  await fs.writeFile(library.config, catalog(library.first));
  await until(() => explorer.tooling.states.analyzer.phase === "ready", "fixed entry restarts LSP");
  pids.add(explorer.language.session.owner.child.pid);
  await until(() => definition(library.first), "definition recovers in first library");
  assert.equal(document.getText(), dirty); assert.equal(document.isDirty, true);
  assert.deepEqual(await fs.readFile(path.join(fixture.root, "eska.toml")), manifest);
  for (const base of [library.first, library.second]) for (const file of ["eska.toml", "bsl-analyzer.toml", ".eska"]) {
    await assert.rejects(fs.access(path.join(base.root, file)), { code: "ENOENT" });
  }
  assert.equal(await editor.edit(edit => edit.replace(new vscode.Range(document.positionAt(0), document.positionAt(document.getText().length)), original)), true);
  await fs.writeFile(path.join(fixture.root, "host-result.json"), JSON.stringify({ passed: true, suite: "language-library", vscode: vscode.version,
    analyzer: explorer.tooling.states.analyzer.info?.version, path_changed: true, recovery: true, dirty_preserved: true,
    external_definition: true, line_length_preserved: true, shutdownPids: [...pids] }));
}

exports.run = async function () {
  try { await run(); }
  catch (error) {
    const fixture = JSON.parse(process.env.ESKA_HOST_FIXTURE);
    await fs.writeFile(path.join(fixture.root, "host-result.json"), JSON.stringify({ passed: false, stage, error: String(error), stack: error?.stack }));
    throw error;
  }
};
