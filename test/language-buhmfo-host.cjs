const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const vscode = require("vscode");
const execute = promisify(execFile);
let stage = "bootstrap";
let observe = async () => ({});

/** Await an actual model transition on the large, exclusively owned Designer XML copy. */
async function until(operation, label, timeout = 120000) {
  const end = Date.now() + timeout;
  let last;
  while (Date.now() < end) {
    try { const result = await operation(); if (result) return result; }
    catch (error) { last = String(error); }
    await new Promise(done => setTimeout(done, 100));
  }
  throw new Error(`${label}; last=${last}`);
}

/** Preserve the current native phase before any long provider deadline. */
async function enter(value) {
  stage = value;
  await fs.writeFile(process.env.ESKA_HOST_LARGE_REPORT + ".progress.json", JSON.stringify({ stage, time: Date.now() }));
}

/** Only observe identities recorded by this native fixture. */
function exited(pid) {
  try { process.kill(pid, 0); return false; }
  catch (error) { if (error.code === "ESRCH") return true; throw error; }
}

/** Normal editor edits exercise native document synchronization without saving unrelated input. */
async function replace(editor, text) {
  assert.equal(await editor.edit(edit => edit.replace(new vscode.Range(0, 0, editor.document.lineCount, 0), text)), true);
}

/** Resolve a real call through the installed Explorer and published upstream server. */
async function definitions(document, name) {
  const column = document.lineAt(1).text.indexOf(name); assert.ok(column >= 0);
  return await vscode.commands.executeCommand("vscode.executeDefinitionProvider", document.uri, new vscode.Position(1, column + 2)) ?? [];
}

/** Keep the expected file identity explicit when checking provider results. */
function pointsTo(values, file) { return values.some(value => (value.targetUri ?? value.uri).fsPath === file); }

/** Select only the checked local fixture branch through the public product workflow. */
async function switchBranch(root, base) {
  await execute(process.env.ESKA_TEST_VCS_BINARY, ["--lang", "en", "switch", ...(base ? ["--base"] : ["t89-branch"]),
    "--format", "json", "--project-dir", root], { timeout: 120000 });
}

/** Prove XML, branch, fingerprint and selected-application changes on the full six-source application. */
async function run() {
  const input = JSON.parse(await fs.readFile(process.env.ESKA_HOST_LARGE_INPUT, "utf8"));
  const root = path.resolve(input.root), playground = path.resolve(process.env.ESKA_TEST_ROOT);
  assert.ok(root.startsWith(playground + path.sep), "only the runner's sibling playground copy is writable");
  await fs.access(path.join(path.dirname(root), "owner.json"));
  const file = key => path.join(root, input[key]);
  const common = file("common"), xml = file("commonXml"), caller = file("caller"), extension = file("extension"), descriptor = file("descriptor");
  const xmlBytes = await fs.readFile(xml), rootBytes = await fs.readFile(descriptor), initialCaller = await fs.readFile(caller, "utf8");
  const explorer = await vscode.extensions.all.find(value => value.packageJSON.name === "eska-explorer").activate();
  await vscode.commands.executeCommand("eska.explorer.connect");
  await until(() => explorer.connection.state.kind === "ready", "large metadata ready");
  assert.equal(explorer.support.enabled, false);
  let sourceDocument = await vscode.workspace.openTextDocument(vscode.Uri.file(common));
  await vscode.window.showTextDocument(sourceDocument, { preview: false, preserveFocus: true });
  let document = await vscode.workspace.openTextDocument(vscode.Uri.file(caller));
  const editor = await vscode.window.showTextDocument(document, { preview: false });
  observe = async () => ({ phase: explorer.tooling.states.analyzer.phase, context: explorer.language.session?.context,
    folders: vscode.workspace.workspaceFolders?.map(value => value.uri.toString()),
    watcher_exclude: vscode.workspace.getConfiguration("files", document.uri).get("watcherExclude"),
    open_documents: vscode.workspace.textDocuments.filter(doc => [common, caller, extension].includes(doc.uri.fsPath))
      .map(doc => ({ file: doc.uri.fsPath, closed: doc.isClosed, dirty: doc.isDirty, text: doc.getText() })),
    source_closed: sourceDocument.isClosed, caller_closed: document.isClosed,
    source_text: sourceDocument.getText(), caller_text: document.getText(),
    disk_source: await fs.readFile(common, "utf8"), disk_caller: await fs.readFile(caller, "utf8") });
  await until(() => explorer.tooling.states.analyzer.phase === "ready", "large LSP ready");
  assert.equal(explorer.language.session.context.sources.length, 6);
  const initial = explorer.language.session.owner.child.pid, metadataPid = explorer.connection.child.pid, pids = [initial, metadataPid];
  await until(async () => pointsTo(await definitions(document, "ESKABaseline"), common), "qualified definition before XML update");
  await enter("native-file-watcher-ready");
  const commonBytes = await fs.readFile(common);
  let readyAttempt = 0;
  try {
    await until(async () => {
      const next = commonBytes.toString("utf8") + `// ESKAWatchReady${readyAttempt++}\n`;
      await fs.writeFile(common, next);
      await new Promise(done => setTimeout(done, 200));
      return sourceDocument.getText() === next;
    }, "the native editor observes ordinary external BSL changes before testing branches", 30000);
  } finally { await fs.writeFile(common, commonBytes); }
  await until(() => sourceDocument.getText() === commonBytes.toString("utf8"), "watcher control source restored", 15000);

  await enter("xml-global-resolution");
  await replace(editor, initialCaller.replace("GoogleПереводчик.", ""));
  await until(async () => (await definitions(document, "ESKABaseline")).length === 0, "non-global function is absent");
  const globalXml = Buffer.from(xmlBytes.toString("utf8").replace("<Global>false</Global>", "<Global>true</Global>"));
  assert.notDeepEqual(globalXml, xmlBytes);
  await fs.writeFile(xml, globalXml);
  await until(async () => pointsTo(await definitions(document, "ESKABaseline"), common), "XML Global changes real large-project resolution");
  assert.equal(explorer.language.session.owner.child.pid, initial);
  await fs.writeFile(xml, xmlBytes);
  await until(async () => (await definitions(document, "ESKABaseline")).length === 0, "restored XML removes global resolution");
  await replace(editor, initialCaller); assert.equal(await document.save(), true);

  await enter("branch-roundtrip");
  await switchBranch(root, false);
  await until(() => {
    sourceDocument = vscode.workspace.textDocuments.find(doc => doc.uri.fsPath === common && !doc.isClosed) ?? sourceDocument;
    document = vscode.workspace.textDocuments.find(doc => doc.uri.fsPath === caller && !doc.isClosed) ?? document;
    return !document.isClosed && !sourceDocument.isClosed && document.getText().includes("ESKABranch") && sourceDocument.getText().includes("ESKABranch");
  }, "clean editors reload the fixture branch", 15000);
  await until(async () => pointsTo(await definitions(document, "ESKABranch"), common), "definition reflects branch contents");
  await until(() => vscode.languages.getDiagnostics(document.uri).some(value => value.message.includes("ESKABranchSentinel")), "fresh branch diagnostics");
  assert.equal(explorer.language.session.owner.child.pid, initial);
  await switchBranch(root, true);
  await until(() => {
    sourceDocument = vscode.workspace.textDocuments.find(doc => doc.uri.fsPath === common && !doc.isClosed) ?? sourceDocument;
    document = vscode.workspace.textDocuments.find(doc => doc.uri.fsPath === caller && !doc.isClosed) ?? document;
    return !document.isClosed && !sourceDocument.isClosed && document.getText() === initialCaller && !sourceDocument.getText().includes("ESKABranch");
  }, "original branch buffers restored", 15000);
  await until(async () => pointsTo(await definitions(document, "ESKABaseline"), common), "restored branch definition");
  await until(() => {
    const values = vscode.languages.getDiagnostics(document.uri);
    return values.some(value => value.message.includes("ESKALifecycleSentinel")) && !values.some(value => value.message.includes("ESKABranchSentinel"));
  }, "restored branch diagnostics replace previous results");
  assert.equal(explorer.language.session.owner.child.pid, initial);

  await enter("root-fingerprint");
  const fingerprint = explorer.language.session.configuration.fingerprint;
  const changedRoot = Buffer.from(rootBytes.toString("utf8").replace(/<Version>([^<]*)<\/Version>/, "<Version>$1 T89</Version>"));
  assert.notDeepEqual(changedRoot, rootBytes); await fs.writeFile(descriptor, changedRoot);
  await until(() => explorer.tooling.states.analyzer.phase === "ready" && explorer.language.session?.owner?.child.pid !== initial
    && explorer.language.session?.configuration.fingerprint !== fingerprint, "root XML prepares a fresh language context");
  const afterRoot = explorer.language.session.owner.child.pid; pids.push(afterRoot);
  assert.equal(exited(initial), true); assert.equal(explorer.connection.child.pid, metadataPid);
  await until(async () => pointsTo(await definitions(document, "ESKABaseline"), common), "definition in refreshed context");
  await fs.writeFile(descriptor, rootBytes);
  await until(() => explorer.tooling.states.analyzer.phase === "ready" && explorer.language.session?.configuration.fingerprint === fingerprint
    && explorer.language.session?.owner?.child.pid !== afterRoot, "root fingerprint restoration");
  pids.push(explorer.language.session.owner.child.pid);

  await enter("application-roundtrip");
  const extensionDocument = await vscode.workspace.openTextDocument(vscode.Uri.file(extension));
  await vscode.window.showTextDocument(extensionDocument, { preview: false });
  const extensionDiagnostics = () => vscode.languages.getDiagnostics(extensionDocument.uri).filter(value => value.message.includes("ESKAExtensionSentinel"));
  await until(() => extensionDiagnostics().length > 0, "full application includes extension diagnostics");
  const fullPid = explorer.language.session.owner.child.pid;
  await explorer.language.restart(true, "base-only", true);
  await until(() => explorer.tooling.states.analyzer.phase === "ready" && explorer.language.session?.context.name === "base-only", "base-only application ready");
  assert.equal(explorer.language.session.context.sources.length, 1); assert.equal(exited(fullPid), true);
  assert.equal(vscode.languages.match(explorer.language.session.client.clientOptions.documentSelector, extensionDocument), 0);
  await until(() => extensionDiagnostics().length === 0, "excluded extension has no stale diagnostics");
  await until(async () => pointsTo(await definitions(document, "ESKABaseline"), common), "base definition survives context switch");
  const basePid = explorer.language.session.owner.child.pid; pids.push(basePid);
  await explorer.language.restart(true, "buhmfo", true);
  await until(() => explorer.tooling.states.analyzer.phase === "ready" && explorer.language.session?.context.sources.length === 6, "full application restored");
  await until(() => extensionDiagnostics().length > 0, "restored application republishes actual extension diagnostics");
  assert.equal(exited(basePid), true); assert.equal(explorer.connection.child.pid, metadataPid);
  pids.push(explorer.language.session.owner.child.pid);
  await until(() => vscode.languages.getDiagnostics(sourceDocument.uri).some(value => value.message.includes("ESKAModuleSentinel"))
    && vscode.languages.getDiagnostics(document.uri).some(value => value.message.includes("ESKALifecycleSentinel")), "fresh base diagnostics after restoring the full application");
  const diagnostics = [sourceDocument, document, extensionDocument].map(doc => ({ file: doc.uri.fsPath,
    diagnostics: vscode.languages.getDiagnostics(doc.uri).map(value => ({ code: typeof value.code === "object" ? value.code.value : value.code,
      message: value.message, severity: ["Error", "Warning", "Information", "Hint"][value.severity],
      start_line: value.range.start.line, start_column: value.range.start.character,
      end_line: value.range.end.line, end_column: value.range.end.character })) }));
  assert.deepEqual(await fs.readFile(xml), xmlBytes); assert.deepEqual(await fs.readFile(descriptor), rootBytes);
  assert.equal(await fs.readFile(caller, "utf8"), initialCaller);
  return { passed: true, suite: "buhmfo-lifecycle", vscode: vscode.version, sources: 6, support_policy: false,
    native_file_watcher_readiness_attempts: readyAttempt,
    xml_global_resolution: true, ordinary_xml_pid_preserved: true, branch_roundtrip: true, branch_diagnostics_fresh: true,
    root_fingerprint_roundtrip: true, metadata_pid_preserved: true, application_sources_roundtrip: [6, 1, 6],
    excluded_extension_diagnostics_cleared: true, diagnostics, shutdownPids: pids };
}

/** Keep the failing phase and raw report outside the disposable small runner fixture. */
exports.run = async function () {
  let result;
  try { result = await run(); }
  catch (error) { result = { passed: false, stage, error: String(error.stack ?? error), observation: await observe() }; }
  await fs.writeFile(process.env.ESKA_HOST_LARGE_REPORT, JSON.stringify(result, null, 2));
  const fixture = JSON.parse(process.env.ESKA_HOST_FIXTURE);
  await fs.writeFile(path.join(fixture.root, "host-result.json"), JSON.stringify(result));
};
