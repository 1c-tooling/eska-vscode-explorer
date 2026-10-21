const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const { createHash } = require("node:crypto");
const vscode = require("vscode");
const coordination = process.env.ESKA_HOST_COORDINATION, role = process.env.ESKA_HOST_WINDOW_ROLE;
let stage = "bootstrap";

/** Publish each barrier atomically inside the coordinator's uniquely owned directory. */
async function signal(name, value = {}) {
  const file = path.join(coordination, `${name}.json`), temporary = `${file}.${process.pid}.tmp`;
  await fs.writeFile(temporary, JSON.stringify(value)); await fs.rename(temporary, file);
}

/** A missing barrier is pending; peer failure interrupts every subsequent wait. */
async function read(name) {
  try { return JSON.parse(await fs.readFile(path.join(coordination, `${name}.json`), "utf8")); }
  catch (error) { if (error.code === "ENOENT") return undefined; throw error; }
}

/** Poll native state or a named barrier; never infer a process exit from a file alone. */
async function until(predicate, label) {
  const deadline = Date.now() + 45000;
  while (Date.now() < deadline) {
    const failed = await read(`failed-${role === "a" ? "b" : "a"}`);
    if (failed) throw new Error(`Peer failed: ${failed.error}`);
    try { const value = await predicate(); if (value) return value; } catch { /* A starting provider may cancel a read. */ }
    await new Promise(done => setTimeout(done, 50));
  }
  throw new Error(label);
}

/** Hash the exact shared config bytes so a rejected context switch cannot silently modify the other window's input. */
async function configHash(root) { return createHash("sha256").update(await fs.readFile(path.join(root, "bsl-analyzer.toml"))).digest("hex"); }

/** Inspect only an explicitly recorded child PID. */
function exited(pid) { try { process.kill(pid, 0); return false; } catch (error) { if (error.code === "ESRCH") return true; throw error; } }

/** Count only the actual published analyzer's parse errors for this exact document URI. */
function errors(uri) { return vscode.languages.getDiagnostics(uri).filter(value => (typeof value.code === "object" ? value.code.value : value.code) === "ParseError"); }

/** Real contexts and contention are owned by the two metadata processes and the shared OS config lock. */
async function run() {
  assert.ok(["a", "b"].includes(role) && path.isAbsolute(coordination));
  const { workspace, files, names } = await read("fixture");
  assert.equal(vscode.workspace.workspaceFolders[0].uri.fsPath, workspace);
  const explorer = await vscode.extensions.all.find(value => value.packageJSON.name === "eska-explorer").activate();
  assert.equal(explorer.support.enabled, false);
  await until(() => explorer.connection.state.kind === "ready", "metadata ready");
  const metadataPid = explorer.connection.child.pid, pids = [], denied = [];
  const originalLog = explorer.language.log;
  /** Record structured failure categories while keeping normal production logging. */
  explorer.language.log = (value, level) => { if (typeof value === "string" && value.startsWith("{")) {
    const event = JSON.parse(value); if (event.event === "language_failed") denied.push(event.code);
  } originalLog(value, level); };

  /** Open one checked application and prove both actual definition routing and URI-scoped diagnostics. */
  async function start(application) {
    await explorer.language.restart(true, application, true);
    assert.equal(explorer.tooling.states.analyzer.phase, "ready");
    assert.equal(explorer.language.session.context.name, application);
    const pid = explorer.language.session.owner.child.pid; pids.push(pid);
    const document = await vscode.workspace.openTextDocument(vscode.Uri.file(files[application]));
    await vscode.window.showTextDocument(document, { preview: false });
    await until(async () => {
      const position = new vscode.Position(5, document.lineAt(5).text.indexOf(names[application]) + 2);
      const result = await vscode.commands.executeCommand("vscode.executeDefinitionProvider", document.uri, position);
      return result?.some(value => (value.targetUri ?? value.uri).fsPath === files[application] && (value.targetSelectionRange ?? value.range).start.line === 1);
    }, `definition in ${application}`);
    await until(() => errors(document.uri).length > 0, `diagnostics in ${application}`);
    return { pid, document, sha256: await configHash(workspace) };
  }

  /** The exclusive switch must fail before any write while the peer still holds a shared lease. */
  async function rejectSwitch(application, expectedHash) {
    await explorer.language.restart(true, application, true);
    assert.equal(explorer.tooling.states.analyzer.phase, "error"); assert.equal(explorer.language.session, undefined);
    assert.equal(await configHash(workspace), expectedHash); assert.ok(denied.length > 0);
    assert.ok((await explorer.getChildren()).some(value => value.node), "metadata tree survives rejected switch");
  }

  if (role === "a") {
    stage = "first-context"; const first = await start("one"); await signal("a-ready-one", { pid: first.pid, sha256: first.sha256 });
    const shared = await until(() => read("b-shared-one"), "peer shares context one");
    assert.equal(exited(shared.pid), false); assert.notEqual(shared.pid, first.pid);
    stage = "switch-blocked-by-shared-lease"; await rejectSwitch("two", first.sha256);
    assert.equal(exited(first.pid), true); assert.equal(exited(shared.pid), false); await signal("a-switch-blocked");
    await until(() => read("b-stopped-one"), "peer releases shared lease");
    stage = "second-context"; const second = await start("two"); await signal("a-ready-two", { pid: second.pid, sha256: second.sha256 });
    await until(() => read("b-switch-blocked"), "peer cannot replace context two");
    assert.equal(explorer.language.session.owner.child.pid, second.pid); assert.equal(await configHash(workspace), second.sha256);
    await explorer.language.stop(); assert.equal(exited(second.pid), true); await signal("a-stopped-two");
    await until(() => read("b-finished"), "peer checks context one and exits its LSP");
    stage = "single-window-context-replacement"; const again = await start("one");
    const final = await start("two"); assert.equal(exited(again.pid), true);
    await until(() => errors(again.document.uri).length === 0, "old-context diagnostics were withdrawn");
    assert.ok(errors(final.document.uri).length > 0);
    stage = "remembered-context"; const before = final.pid;
    await explorer.language.restart(false);
    assert.equal(explorer.language.session.context.name, "two");
    assert.equal(exited(before), true); pids.push(explorer.language.session.owner.child.pid);
  } else {
    const first = await until(() => read("a-ready-one"), "first window context one");
    stage = "shared-context"; const shared = await start("one");
    assert.equal(shared.sha256, first.sha256); await signal("b-shared-one", { pid: shared.pid, sha256: shared.sha256 });
    await until(() => read("a-switch-blocked"), "peer switch was blocked");
    assert.equal(explorer.language.session.owner.child.pid, shared.pid); assert.equal(await configHash(workspace), shared.sha256);
    await explorer.language.stop(); assert.equal(exited(shared.pid), true); await signal("b-stopped-one");
    const second = await until(() => read("a-ready-two"), "peer context two");
    stage = "opposite-context-switch-blocked"; await rejectSwitch("one", second.sha256); await signal("b-switch-blocked");
    await until(() => read("a-stopped-two"), "peer releases context two");
    stage = "retry-after-release"; const retry = await start("one");
    await explorer.language.stop(); assert.equal(exited(retry.pid), true); await signal("b-finished");
  }
  assert.equal(explorer.connection.child.pid, metadataPid);
  const fixture = JSON.parse(process.env.ESKA_HOST_FIXTURE);
  await fs.writeFile(path.join(fixture.root, "host-result.json"), JSON.stringify({ passed: true, suite: "language-context-window", role,
    vscode: vscode.version, shared_context: true, conflicting_switch_rejected: true, retry_after_release: true,
    tree_preserved: true, config_bytes_preserved: true, application_diagnostics_replaced: role === "a", remembered_context: role === "a",
    failures: denied, shutdownPids: [...pids, metadataPid] }));
}

/** Report the precise phase to the peer and runner before the native host closes. */
exports.run = async function () {
  try { await run(); }
  catch (error) {
    const failure = { error: `${role}/${stage}: ${error.stack ?? error}` };
    await signal(`failed-${role}`, failure);
    const fixture = JSON.parse(process.env.ESKA_HOST_FIXTURE);
    await fs.writeFile(path.join(fixture.root, "host-result.json"), JSON.stringify({ passed: false, ...failure }));
  }
};
