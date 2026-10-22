const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const vscode = require("vscode");
const { revealFile } = require("../out/reveal.js");
let stage = "bootstrap";

/** Wait for a concrete native provider result rather than guessing when its metadata watcher has refreshed. */
async function until(predicate, label) {
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    try { const value = await predicate(); if (value) return value; } catch { /* Startup/model replacement can cancel a read. */ }
    await new Promise(done => setTimeout(done, 50));
  }
  throw new Error(label);
}

/** Read definitions from the actual published language server. */
async function definition(document) {
  const character = document.lineAt(1).text.indexOf("Проверка"); assert.ok(character >= 0);
  return (await vscode.commands.executeCommand("vscode.executeDefinitionProvider", document.uri, new vscode.Position(1, character + 2))) ?? [];
}

/** Metadata API mutations must invalidate the language model even without the editor's batching watcher. */
async function run() {
  const fixture = JSON.parse(process.env.ESKA_HOST_FIXTURE);
  assert.equal(process.env.ESKA_HOST_LANGUAGE_MUTATION, "1");
  const module = path.join(fixture.source, "CommonModules", "Обмен", "Ext", "Module.bsl");
  const moduleXml = path.join(fixture.source, "CommonModules", "Обмен.xml"), original = await fs.readFile(moduleXml);
  const qualified = "Процедура Использовать()\n    Значение = Обмен.Проверка(1);\nКонецПроцедуры\n";
  const unqualified = qualified.replace("Обмен.", "");
  const caller = path.join(fixture.source, "CommonModules", "Защищенный", "Ext", "Module.bsl");
  const explorer = await vscode.extensions.all.find(value => value.packageJSON.name === "eska-explorer").activate();
  await until(() => explorer.connection.state.kind === "ready", "metadata ready");
  assert.equal(explorer.support.enabled, true);
  await until(async () => (await explorer.support.languageWriteAccess([caller]))(), "caller permission is confirmed before showing its editor");
  const source = await vscode.workspace.openTextDocument(vscode.Uri.file(module));
  const document = await vscode.workspace.openTextDocument(vscode.Uri.file(caller));
  const editor = await vscode.window.showTextDocument(document, { preview: false });
  await until(() => explorer.tooling.states.analyzer.phase === "ready", "own LSP ready");
  await until(async () => (await definition(document)).some(value => (value.targetUri ?? value.uri).fsPath === module), "qualified definition before metadata edit");
  const pid = explorer.language.session.owner.child.pid, metadataPid = explorer.connection.child.pid;
  assert.equal(await editor.edit(edit => edit.replace(new vscode.Range(0, 0, document.lineCount, 0), unqualified)), true);
  await until(async () => (await definition(document)).length === 0, "non-global module is not visible without qualification");
  const entry = await revealFile(explorer.tree, moduleXml); assert.ok(entry);
  const objectId = entry.node.id.kind === "object" ? entry.node.id.objectId : entry.node.id.owner;
  const events = [];
  const listener = explorer.connection.onNotification((method, params) => { if (method === "metadata/changed") events.push(params); });
  // Isolate the real backend notification path; upstream's own filesystem watcher remains active.
  for (const watcher of explorer.watchers) if (watcher.project?.info.projectId === entry.project.info.projectId) watcher.dispose();

  /** Address a writable boolean by the fresh backend schema/snapshot used by the property editor. */
  async function setGlobal(value) {
    const schema = await explorer.tree.request(entry.project, "metadata/propertyEditing", { objectId });
    assert.equal(schema.writable, true, "the real support fixture permits this common module");
    const field = schema.fields.find(item => item.path.at(-1).key.name === "Global");
    assert.ok(field && field.schema.kind === "boolean");
    const result = await explorer.tree.request(entry.project, "metadata/updateProperty", { objectId, snapshot: schema.snapshot,
      path: field.path, change: { kind: "text", value: String(value) }, ...(field.linked ? { contextSnapshot: schema.contextSnapshot } : {}) });
    assert.equal(result.editing.fields.find(item => item.path.at(-1).key.name === "Global").value, String(value));
  }

  stage = "metadata-api-update";
  const before = explorer.language.modelRevision;
  await setGlobal(true);
  assert.ok(events.some(event => event.projectId === entry.project.info.projectId));
  assert.ok(explorer.language.modelRevision > before, "metadata notification invalidated the old model");
  await until(async () => (await definition(document)).some(value => (value.targetUri ?? value.uri).fsPath === module), "ESKA property update changes actual BSL resolution");
  assert.equal(explorer.language.session.owner.child.pid, pid); assert.equal(explorer.connection.child.pid, metadataPid);
  stage = "metadata-api-restore";
  await setGlobal(false);
  await until(async () => (await definition(document)).length === 0, "restoring ESKA property removes global resolution");
  assert.deepEqual(await fs.readFile(moduleXml), original);
  assert.equal(await fs.readFile(caller, "utf8"), qualified);
  assert.equal(source.getText().includes("Функция Проверка"), true);
  listener.dispose();
  await fs.writeFile(path.join(fixture.root, "host-result.json"), JSON.stringify({ passed: true, suite: "language-metadata-mutation", vscode: vscode.version,
    real_backend_property_write: true, isolated_metadata_notification: true, support_policy_enabled: true,
    global_resolution_updated: true, source_xml_byte_roundtrip: true, bsl_disk_unchanged: true, lsp_pid_preserved: true,
    shutdownPids: [pid, metadataPid] }));
}

/** Record the exact backend/provider phase before the runner removes its own fixture. */
exports.run = async function () {
  try { await run(); }
  catch (error) {
    const fixture = JSON.parse(process.env.ESKA_HOST_FIXTURE);
    await fs.writeFile(path.join(fixture.root, "host-result.json"), JSON.stringify({ passed: false, error: `${stage}: ${error.stack ?? error}` }));
  }
};
