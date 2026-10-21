const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const vscode = require("vscode");

/** Bound controlled cancellation checkpoints independently of the validator's normal timeout. */
async function until(action, label) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) { if (await action()) return; await new Promise(resolve => setTimeout(resolve, 30)); }
  throw new Error(typeof label === "function" ? label() : label);
}

/** Only recorded owned process identities are inspected, without terminating an unrelated process. */
function exited(pid) { try { process.kill(pid, 0); return false; } catch (error) { if (error.code === "ESRCH") return true; throw error; } }

/** Cancellation during validation and during a lease reply must preserve metadata and leave no orphan lease. */
exports.run = async function () {
  const fixture = JSON.parse(process.env.ESKA_HOST_FIXTURE), python = process.env.ESKA_TEST_PYTHON;
  assert.ok(python && path.isAbsolute(python), "Set ESKA_TEST_PYTHON for this executable fixture");
  assert.ok(fixture.languageSource, "prepare the complete source before launching the editor");
  const source = fixture.languageSource;
  const wrapper = path.join(fixture.root, "controlled-analyzer"), marker = path.join(fixture.root, "validator-pid");
  await fs.writeFile(wrapper, `#!${python}\nimport os,sys,time\nfrom pathlib import Path\nif len(sys.argv)>1 and sys.argv[1]=='check-config':\n Path(${JSON.stringify(marker)}).write_text(str(os.getpid()))\n while True: time.sleep(.1)\nos.execv(${JSON.stringify(process.env.ESKA_TEST_ANALYZER_BINARY)},[${JSON.stringify(process.env.ESKA_TEST_ANALYZER_BINARY)},*sys.argv[1:]])\n`, { mode: 0o755 });
  const config = vscode.workspace.getConfiguration("eska.explorer");
  const extension = vscode.extensions.all.find(value => value.packageJSON.name === "eska-explorer"), explorer = await extension.activate();
  await until(() => explorer.connection.state.kind === "ready", () => `metadata ready: ${JSON.stringify({
    state: explorer.connection.state, selected: explorer.selected?.uri.toString(), tooling: explorer.tooling.states,
  })}`);
  // The controlled cancellation begins after metadata startup, independent of initial configuration delivery.
  await config.update("analyzerExecutable", wrapper, vscode.ConfigurationTarget.Workspace);
  const document = await vscode.workspace.openTextDocument(vscode.Uri.file(source.file));
  await vscode.window.showTextDocument(document);
  await until(() => fs.access(marker).then(() => true, () => false), "real project validator started");
  const validatorPid = Number(await fs.readFile(marker, "utf8"));
  await config.update("languageFeatures", false, vscode.ConfigurationTarget.Workspace);
  await until(() => exited(validatorPid), "cancelled validator reaped");
  await explorer.language.queue;
  assert.equal(explorer.language.session, undefined);
  await assert.rejects(fs.access(path.join(fixture.root, "bsl-analyzer.toml")), "cancelled validation cannot publish config");
  assert.equal(explorer.connection.state.kind, "ready");
  const request = explorer.connection.analyzerRequest.bind(explorer.connection);
  let acquired, releaseReply;
  const held = new Promise(resolve => { releaseReply = resolve; });
  explorer.connection.analyzerRequest = async (method, params, signal) => {
    const value = await request(method, params, signal);
    if (method === "analyzer/acquire") {
      acquired = value; await held;
      // Model a response handed off after an abort: callers must acquire without a cancellation token.
      if (signal?.aborted) throw new Error("lost lease identity");
    }
    return value;
  };
  try {
    await config.update("analyzerExecutable", process.env.ESKA_TEST_ANALYZER_BINARY, vscode.ConfigurationTarget.Workspace);
    await config.update("languageFeatures", true, vscode.ConfigurationTarget.Workspace);
    await until(() => !!acquired, "real lease acquired before frontend handoff");
    const stopped = explorer.language.stop();
    releaseReply(); await stopped;
    assert.equal(explorer.language.session, undefined);
  } finally { releaseReply(); explorer.connection.analyzerRequest = request; }
  const start = { value: fixture.root, encoding: "utf-8" };
  const next = await request("analyzer/acquire", { start });
  await request("analyzer/release", { leaseId: next.leaseId });
  assert.equal(explorer.connection.state.kind, "ready");
  assert.ok((await explorer.getChildren()).some(entry => entry.node));
  await fs.writeFile(path.join(fixture.root, "host-result.json"), JSON.stringify({ passed: true, suite: "language-cancellation",
    vscode: vscode.version, validator_reaped: true, config_not_published_on_cancel: true, lease_handoff_released: true,
    metadata_preserved: true, shutdownPids: [validatorPid] }));
};
