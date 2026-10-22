const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const { promisify } = require("node:util");
const { execFile } = require("node:child_process");
const vscode = require("vscode");
const execute = promisify(execFile);
let stage = "bootstrap";
const trace = [];

/** Wait for a concrete native provider, file or lifecycle transition with a fixed deadline. */
async function until(predicate, label) {
  const deadline = Date.now() + 30000;
  let last;
  while (Date.now() < deadline) {
    try { const value = await predicate(); if (value) return value; }
    catch (error) { last = String(error); }
    await new Promise(done => setTimeout(done, 50));
  }
  throw new Error(`${typeof label === "function" ? label() : label}; last=${last}`);
}

/** Observe only a PID created and recorded by this disposable profile. */
function exited(pid) { try { process.kill(pid, 0); return false; } catch (error) { if (error.code === "ESRCH") return true; throw error; } }

/** Buffer replacements use normal editor events and never bypass document synchronization. */
async function replace(editor, text) {
  assert.equal(await editor.edit(edit => edit.replace(new vscode.Range(0, 0,
    editor.document.lineCount, 0), text)), true);
}

/** Git fixtures are local, uniquely owned and use no repository outside the runner's project. */
async function git(root, ...args) {
  return execute("git", ["-c", "maintenance.auto=false", "-c", "user.name=ESKA fixture", "-c", "user.email=fixture@example.invalid", ...args], { cwd: root, timeout: 30000 });
}

/** Query the actual upstream definition provider and normalize the two standard result representations. */
async function definition(document, name) {
  const character = document.lineAt(1).text.indexOf(name);
  assert.ok(character >= 0, `call ${name} is in the current buffer`);
  return (await vscode.commands.executeCommand("vscode.executeDefinitionProvider", document.uri, new vscode.Position(1, character + 2))) ?? [];
}

/** Published upstream handles ordinary XML/BSL incrementally; ESKA owns config inputs, generations and leases. */
async function run() {
  const fixture = JSON.parse(process.env.ESKA_HOST_FIXTURE);
  assert.equal(process.env.ESKA_HOST_LANGUAGE_REFRESH, "1");
  const explorer = await vscode.extensions.all.find(value => value.packageJSON.name === "eska-explorer").activate();
  const log = explorer.language.log;
  explorer.language.log = (value, level) => {
    if (trace.length < 200 && typeof value === "string" && value.startsWith("{")) trace.push(JSON.parse(value));
    log(value, level);
  };
  await until(() => explorer.connection.state.kind === "ready", "metadata ready");
  assert.equal(explorer.language.session, undefined);
  const module = path.join(fixture.source, "CommonModules", "Обмен", "Ext", "Module.bsl");
  const moduleXml = path.join(fixture.source, "CommonModules", "Обмен.xml");
  const originalModule = await fs.readFile(module, "utf8"), originalXml = await fs.readFile(moduleXml, "utf8");
  const qualified = name => `Процедура Использовать()\n    Значение = Обмен.${name}(1);\nКонецПроцедуры\n`;
  const unqualified = "Процедура Использовать()\n    Значение = Проверка(1);\nКонецПроцедуры\n";
  await fs.writeFile(fixture.module, qualified("Проверка"));
  stage = "git-fixture";
  await git(fixture.root, "init", "-b", "fixture-a");
  await fs.writeFile(path.join(fixture.root, ".gitignore"), ".eska/\nbsl-analyzer.toml\n.vscode/\nhost-result.json\n");
  await git(fixture.root, "add", "src", "eska.toml", ".gitignore"); await git(fixture.root, "commit", "-m", "Fixture A");
  await git(fixture.root, "switch", "-c", "fixture-b");
  await fs.writeFile(module, originalModule.replaceAll("Проверка", "ВеткаПроверка"));
  await fs.writeFile(fixture.module, qualified("ВеткаПроверка"));
  await fs.writeFile(moduleXml, originalXml.replace("<Global>false</Global>", "<Global>true</Global>"));
  await git(fixture.root, "add", "src"); await git(fixture.root, "commit", "-m", "Fixture B");
  await git(fixture.root, "switch", "fixture-a");
  stage = "language-ready";
  const sourceDocument = await vscode.workspace.openTextDocument(vscode.Uri.file(module));
  const document = await vscode.workspace.openTextDocument(vscode.Uri.file(fixture.module));
  const editor = await vscode.window.showTextDocument(document);
  await until(() => explorer.tooling.states.analyzer.phase === "ready", "LSP ready");
  const initial = explorer.language.session.owner.child.pid, metadataPid = explorer.connection.child.pid;
  await until(async () => (await definition(document, "Проверка")).some(value => (value.targetUri ?? value.uri).fsPath === module), "qualified common-module definition");
  stage = "xml-global-flag";
  await replace(editor, unqualified);
  assert.equal((await definition(document, "Проверка")).length, 0, "non-global module is not an unqualified function");
  await fs.writeFile(moduleXml, originalXml.replace("<Global>false</Global>", "<Global>true</Global>"));
  await until(async () => (await definition(document, "Проверка")).some(value => (value.targetUri ?? value.uri).fsPath === module), "XML Global flag changes actual BSL resolution");
  assert.equal(explorer.language.session.owner.child.pid, initial, "ordinary XML does not start another index");
  await fs.writeFile(moduleXml, originalXml);
  await until(async () => (await definition(document, "Проверка")).length === 0, "restoring XML removes the global function");
  await replace(editor, qualified("Проверка")); assert.equal(await document.save(), true);
  stage = "branch-switch";
  await git(fixture.root, "switch", "fixture-b");
  await until(() => document.getText().includes("ВеткаПроверка") && sourceDocument.getText().includes("ВеткаПроверка"), "editor reloads clean BSL after branch switch");
  await until(async () => (await definition(document, "ВеткаПроверка")).some(value => (value.targetUri ?? value.uri).fsPath === module), "definition after branch switch");
  assert.equal(explorer.language.session.owner.child.pid, initial);
  await git(fixture.root, "switch", "fixture-a");
  await until(() => document.getText() === qualified("Проверка") && sourceDocument.getText() === originalModule, "source restoration after branch switch");
  await until(async () => (await definition(document, "Проверка")).length > 0, "restored branch definition");
  assert.equal(explorer.language.session.owner.child.pid, initial);
  stage = "rapid-diagnostics";
  const clean = document.getText(), broken = clean + "Функция Сломано(\n";
  const errors = () => vscode.languages.getDiagnostics(document.uri).filter(value => (typeof value.code === "object" ? value.code.value : value.code) === "ParseError");
  await replace(editor, broken); await until(() => errors().length > 0, "broken buffer diagnostics");
  for (let index = 0; index < 30; index++) await replace(editor, index % 2 === 0 ? broken : clean);
  await until(async () => errors().length === 0 && (await definition(document, "Проверка")).length > 0, "latest repaired buffer has no stale diagnostics");
  assert.equal(await document.save(), true);
  stage = "root-descriptor";
  const rootXml = path.join(fixture.source, "Configuration.xml"), rootBytes = await fs.readFile(rootXml, "utf8");
  const fingerprint = explorer.language.session.configuration.fingerprint;
  await fs.writeFile(rootXml, rootBytes.replace("😀 Кириллица", "😀 Обновлённый контекст"));
  await until(() => explorer.tooling.states.analyzer.phase === "ready" && explorer.language.session?.owner?.child.pid !== initial
    && explorer.language.session?.configuration.fingerprint !== fingerprint, "root descriptor prepares a new fingerprint and LSP");
  const afterRoot = explorer.language.session.owner.child.pid;
  assert.equal(exited(initial), true); assert.equal(explorer.connection.child.pid, metadataPid);
  await until(async () => (await definition(document, "Проверка")).length > 0, "new client reads the existing document");
  stage = "same-config-bytes";
  const config = path.join(fixture.root, "bsl-analyzer.toml"), configBytes = await fs.readFile(config);
  await replace(editor, broken); await until(() => errors().length > 0, "diagnostics before same-byte config event");
  const previousChecks = trace.filter(value => value.event === "language_context_current").length;
  await fs.writeFile(config, configBytes);
  await until(() => !explorer.language.configurationPending && trace.filter(value => value.event === "language_context_current").length > previousChecks, "same-byte config recheck");
  assert.equal(explorer.language.session.owner.child.pid, afterRoot);
  await until(() => errors().length > 0, "same-byte config retains valid diagnostics");
  await replace(editor, clean); await until(() => errors().length === 0, "repair after same-byte config");
  assert.equal(await document.save(), true);
  stage = "manifest-reconnect";
  const manifest = path.join(fixture.root, "eska.toml");
  await fs.appendFile(manifest, "\n# changed context input\n");
  await until(() => explorer.connection.state.kind === "ready" && explorer.connection.child.pid !== metadataPid
    && explorer.tooling.states.analyzer.phase === "ready" && explorer.language.session?.owner?.child.pid !== afterRoot, "manifest reconnects both owned services");
  const afterManifest = explorer.language.session.owner.child.pid, lastMetadata = explorer.connection.child.pid;
  assert.equal(exited(afterRoot), true); assert.equal(exited(metadataPid), true);
  await until(async () => (await definition(document, "Проверка")).length > 0, "manifest replacement preserves open documents");
  stage = "managed-config-conflict";
  const manual = Buffer.concat([await fs.readFile(config), Buffer.from("\n# manually changed managed body\n")]);
  await fs.writeFile(config, manual);
  await until(() => explorer.tooling.states.analyzer.phase === "error" && !explorer.language.session && exited(afterManifest), "manual managed-config change stops own LSP");
  assert.deepEqual(await fs.readFile(config), manual); assert.equal(explorer.connection.child.pid, lastMetadata);
  await fs.writeFile(path.join(fixture.root, "host-result.json"), JSON.stringify({ passed: true, suite: "language-refresh", vscode: vscode.version,
    xml_global_resolution: true, incremental_xml_pid_preserved: true, branch_roundtrip: true, rapid_buffer_edits: 30,
    repaired_diagnostics: errors().length, root_fingerprint_reprepared: true, root_metadata_pid_preserved: true,
    same_config_bytes_no_restart: true, same_config_diagnostics_preserved: true, manifest_reconnect: true, managed_conflict_preserved: true,
    shutdownPids: [initial, metadataPid, afterRoot, afterManifest, lastMetadata] }));
}

/** Preserve the exact failed transition before the runner removes its disposable project. */
exports.run = async function () {
  try { await run(); }
  catch (error) {
    const fixture = JSON.parse(process.env.ESKA_HOST_FIXTURE);
    await fs.writeFile(path.join(fixture.root, "host-result.json"), JSON.stringify({ passed: false, error: `${stage}: ${error.stack ?? error}\n${JSON.stringify(trace)}` }));
  }
};
