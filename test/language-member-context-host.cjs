const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const vscode = require("vscode");
let stage = "bootstrap";

/** Observe actual provider and lifecycle state; startup cancellations are retried within one deadline. */
async function until(predicate, label) {
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    try { const result = await predicate(); if (result) return result; } catch { /* A superseded request can cancel. */ }
    await new Promise(done => setTimeout(done, 50));
  }
  throw new Error(label);
}

/** Only inspect PIDs owned by this test's recorded language session. */
function exited(pid) { try { process.kill(pid, 0); return false; } catch (error) { if (error.code === "ESRCH") return true; throw error; } }

/** Normalize standard definition responses without substituting a language provider. */
async function definition(document, name, line = 5) {
  const character = document.lineAt(line).text.indexOf(name); assert.ok(character >= 0);
  return (await vscode.commands.executeCommand("vscode.executeDefinitionProvider", document.uri, new vscode.Position(line, character + 2))) ?? [];
}

/** A member's metadata tree must not prevent the selected application's other sources from invalidating its LSP config. */
async function run() {
  const data = JSON.parse(await fs.readFile(path.join(process.env.ESKA_HOST_COORDINATION, "fixture.json"), "utf8"));
  const { workspace, files, names } = data;
  assert.equal(vscode.workspace.workspaceFolders[0].uri.fsPath, path.join(workspace, "a"));
  const explorer = await vscode.extensions.all.find(value => value.packageJSON.name === "eska-explorer").activate();
  await until(() => explorer.connection.state.kind === "ready", "metadata ready");
  assert.equal(explorer.support.enabled, false);
  assert.equal(explorer.connection.state.session.projects.length, 1);
  assert.equal(explorer.connection.state.session.projects[0].rootPath.value, path.join(workspace, "a"));
  const metadataPid = explorer.connection.child.pid;
  stage = "application-outside-tree";
  await explorer.language.restart(true, "two", true);
  assert.equal(explorer.tooling.states.analyzer.phase, "ready");
  assert.equal(explorer.language.session.context.name, "two");
  const document = await vscode.workspace.openTextDocument(vscode.Uri.file(files.two));
  await vscode.window.showTextDocument(document);
  await until(async () => (await definition(document, names.two)).some(value => (value.targetUri ?? value.uri).fsPath === files.two), "definition in source outside metadata selection");
  const source = explorer.language.session.context.sources[0], initial = explorer.language.session.owner.child.pid;
  assert.equal(source.root, path.join(workspace, "b"));
  const fingerprint = explorer.language.session.configuration.fingerprint;
  stage = "external-root-descriptor";
  const original = await fs.readFile(source.descriptor, "utf8");
  await fs.writeFile(source.descriptor, original.replace("😀 Кириллица", "😀 Другой source"));
  await until(() => explorer.tooling.states.analyzer.phase === "ready" && explorer.language.session?.owner?.child.pid !== initial
    && explorer.language.session?.configuration.fingerprint !== fingerprint, "root descriptor outside metadata selection re-prepares context");
  const afterRoot = explorer.language.session.owner.child.pid;
  assert.equal(exited(initial), true); assert.equal(explorer.connection.child.pid, metadataPid);
  stage = "external-member-manifest";
  const beforeManifest = explorer.language.session.configuration.fingerprint;
  await fs.appendFile(path.join(source.root, "eska.toml"), "\n# member-specific analyzer input\n");
  await until(() => explorer.tooling.states.analyzer.phase === "ready" && explorer.language.session?.owner?.child.pid !== afterRoot
    && explorer.language.session?.configuration.fingerprint !== beforeManifest, "member manifest outside metadata selection re-prepares context");
  const afterManifest = explorer.language.session.owner.child.pid;
  assert.equal(exited(afterRoot), true); assert.equal(explorer.connection.child.pid, metadataPid);
  stage = "external-incremental-xml";
  const moduleXml = path.join(source.source, "CommonModules", "Обмен.xml"), xml = await fs.readFile(moduleXml, "utf8");
  const caller = path.join(source.source, "Catalogs", "Товары", "Ext", "ObjectModule.bsl");
  await fs.writeFile(caller, `Процедура ВнешнийВызов()\n    Значение = ${names.two}(1);\nКонецПроцедуры\n`);
  const callerDocument = await vscode.workspace.openTextDocument(vscode.Uri.file(caller));
  await vscode.window.showTextDocument(callerDocument);
  assert.equal((await definition(callerDocument, names.two, 1)).length, 0);
  const model = explorer.language.modelRevision;
  await fs.writeFile(moduleXml, xml.replace("<Global>false</Global>", "<Global>true</Global>"));
  await until(async () => (await definition(callerDocument, names.two, 1)).some(value => (value.targetUri ?? value.uri).fsPath === files.two), "incremental XML resolution outside metadata selection");
  assert.ok(explorer.language.modelRevision > model);
  assert.equal(explorer.language.session.owner.child.pid, afterManifest);
  assert.equal(explorer.connection.child.pid, metadataPid);
  assert.equal(explorer.supportContexts.connections.length, 0, "language observers do not start another metadata index");
  stage = "external-source-permission";
  await vscode.workspace.getConfiguration("eska.explorer").update("supportPolicy", true, vscode.ConfigurationTarget.Workspace);
  await until(async () => (await explorer.support.languageWriteAccess([files.two]))(), "selected source outside the tree has confirmed backend permission");
  const current = await vscode.workspace.openTextDocument(vscode.Uri.file(files.two));
  const parameter = new vscode.Position(1, current.lineAt(1).text.indexOf("Значение") + 2);
  const rename = await until(async () => {
    const edit = await vscode.commands.executeCommand("vscode.executeDocumentRenameProvider", current.uri, parameter, "Аргумент");
    return edit?.size && edit;
  }, "permitted rename outside metadata tree");
  assert.equal(await vscode.workspace.applyEdit(rename), true);
  assert.match(current.getText(), /Аргумент/);
  const policyPids = explorer.supportContexts.connections.map(connection => connection.child?.pid).filter(Boolean);
  const fixture = JSON.parse(process.env.ESKA_HOST_FIXTURE);
  await fs.writeFile(path.join(fixture.root, "host-result.json"), JSON.stringify({ passed: true, suite: "language-member-context", role: "member", vscode: vscode.version,
    metadata_member_only: true, outside_application_source: true, external_root_reprepared: true, external_manifest_reprepared: true,
    incremental_external_xml: true, model_invalidated: true, metadata_pid_preserved: true, no_extra_metadata_index_when_policy_disabled: true,
    external_source_policy_confirmed: true, external_source_rename_applied: true,
    shutdownPids: [initial, afterRoot, afterManifest, metadataPid, ...policyPids] }));
}

/** Preserve the precise failed phase after the disposable editor has closed. */
exports.run = async function () {
  try { await run(); }
  catch (error) {
    const fixture = JSON.parse(process.env.ESKA_HOST_FIXTURE);
    await fs.writeFile(path.join(fixture.root, "host-result.json"), JSON.stringify({ passed: false, error: `${stage}: ${error.stack ?? error}` }));
  }
};
