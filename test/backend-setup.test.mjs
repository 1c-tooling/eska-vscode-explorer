import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { mkdtemp, rm, access } from "node:fs/promises";
import { resolve, join } from "node:path";

const require = createRequire(import.meta.url);
const os = require("node:os");
const installation = require("../out/installation.js");
const processListeners = new Set(), endListeners = new Set();
const ui = { approved: false, exitCode: 0, errors: [], tasks: [], paths: [] };
/** A VS Code facade emits process completion before executeTask resolves, exercising the fast-task race. */
const vscode = {
  env: { language: "ru-RU" }, workspace: { isTrusted: true },
  window: {
    async showInformationMessage(_message, action) { return ui.approved ? action : undefined; },
    async showWarningMessage(_message, action) { return ui.approved ? action : undefined; },
    async showErrorMessage(message) { ui.errors.push(message); },
    async withProgress(_options, task) { return task(); },
  },
  Task: class { constructor(...args) { this.args = args; } },
  ProcessExecution: class { constructor(...args) { this.args = args; } },
  TaskScope: { Global: 1 }, TaskRevealKind: { Always: 1 }, TaskPanelKind: { Dedicated: 1 }, ProgressLocation: { Notification: 1 },
  tasks: {
    onDidEndTaskProcess(listener) { processListeners.add(listener); return { dispose() { processListeners.delete(listener); } }; },
    onDidEndTask(listener) { endListeners.add(listener); return { dispose() { endListeners.delete(listener); } }; },
    async executeTask(task) {
      ui.tasks.push(task);
      const execution = { terminate() {} };
      for (const listener of [...processListeners]) listener({ execution, exitCode: ui.exitCode });
      for (const listener of [...endListeners]) listener({ execution });
      return execution;
    },
  },
};
// Load the compiled adapter with a local VS Code facade, without modifying the process module loader.
const backendRequire = createRequire(new URL("../out/backend-setup.js", import.meta.url));
const adapter = { exports: {} };
runInNewContext(`(function(require,module,exports){${readFileSync(new URL("../out/backend-setup.js", import.meta.url), "utf8")}\n})`, { AbortController, AbortSignal })(
  name => name === "vscode" ? vscode : backendRequire(name), adapter, adapter.exports);
const { BackendSetup } = adapter.exports;

/** Restore each dependency after the test in both Bun and Node runtimes. */
function replace(t, target, name, value) {
  const previous = target[name];
  target[name] = value;
  t.after(() => { target[name] = previous; });
}

/** Every simulated installation writes only into an isolated playground home. */
async function fixture(t) {
  const root = await mkdtemp(join(process.env.ESKA_TEST_ROOT ?? resolve("../eska-playground"), "explorer-setup-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  replace(t, os, "homedir", () => root);
  ui.errors = []; ui.tasks = []; ui.paths = []; ui.approved = false; ui.exitCode = 0;
  const events = [];
  const context = { environmentVariableCollection: { prepend(...args) { ui.paths.push(args); } } };
  const setup = new BackendSetup(context, () => {}, async () => { events.push("disconnect"); }, async () => { events.push("reconnect"); });
  t.after(() => setup.dispose());
  return { root, setup, events };
}

test("declining a CLI update starts no task; accepting handles early completion and reconnects", async t => {
  const { root, setup, events } = await fixture(t);
  const path = join(root, "bin/eska");
  replace(t, installation, "inspectGlobal", async () => ({ path, version: ui.tasks.length ? "0.11.1" : "0.11.0", compatible: true, selfUpdate: true }));
  replace(t, installation, "checkUpdate", async () => ({ version: "0.11.1", method: "cargo" }));
  await setup.check(true);
  assert.deepEqual(events, []); assert.equal(ui.tasks.length, 0);
  ui.approved = true;
  await setup.check(true);
  assert.deepEqual(events, ["disconnect", "reconnect"]);
  assert.equal(ui.tasks.length, 1);
  assert.deepEqual(JSON.parse(JSON.stringify(ui.tasks[0].args[4].args.slice(0, 2))), [path, ["update", "--target-version", "0.11.1", "--format", "json"]]);
  assert.equal(ui.errors.length, 0);
  assert.equal(ui.paths.length, 1);
  assert.equal(processListeners.size + endListeners.size, 0);
  await assert.rejects(access(join(root, ".eska/.explorer-install.lock")));
});

test("an update accepted from a background notification reports task failure and releases its lock", async t => {
  const { root, setup, events } = await fixture(t);
  replace(t, installation, "inspectGlobal", async () => ({ path: join(root, "eska"), version: "0.11.0", compatible: true, selfUpdate: true }));
  replace(t, installation, "checkUpdate", async () => ({ version: "0.11.1", method: "installer" }));
  ui.approved = true; ui.exitCode = 7;
  await setup.check(false);
  assert.equal(ui.errors.length, 1);
  assert.deepEqual(events, ["disconnect"]);
  assert.equal(ui.paths.length, 0);
  assert.equal(processListeners.size + endListeners.size, 0);
  await assert.rejects(access(join(root, ".eska/.explorer-install.lock")));
});

test("bootstrap uses exactly the release approved by the user and disposes temporary installer files", async t => {
  const { root, setup } = await fixture(t);
  replace(t, installation, "inspectGlobal", async () => ({ path: join(root, "eska"), version: ui.tasks.length ? "0.11.1" : "0.11.0", compatible: true, selfUpdate: false }));
  let queries = 0, disposed = 0;
  const release = { version: "0.11.1", installer: "fixture-only" };
  replace(t, installation, "latestRelease", async () => { queries++; return release; });
  replace(t, installation, "bootstrapCommand", async (_cli, selected) => {
    assert.equal(selected, release);
    return { executable: "never-executed", args: [], cwd: root, async dispose() { disposed++; } };
  });
  ui.approved = true;
  await setup.check(true);
  assert.equal(queries, 1); assert.equal(disposed, 1); assert.equal(ui.errors.length, 0);
});

/** Await actual probe cleanup during deactivation instead of just sending an abort signal. */
test("shutdown cancels and awaits an in-flight CLI probe without opening installation UI", async t => {
  const { setup } = await fixture(t);
  let started, cleaned;
  const ready = new Promise(resolve => { started = resolve; });
  replace(t, installation, "inspectGlobal", async (_log, signal) => {
    started();
    await new Promise(resolve => signal.addEventListener("abort", resolve, { once: true }));
    await new Promise(resolve => { cleaned = resolve; });
    return undefined;
  });
  const opening = setup.ensure();
  await ready;
  let stopped = false;
  const shutdown = setup.shutdown().then(() => { stopped = true; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(stopped, false);
  cleaned();
  await shutdown;
  assert.equal(await opening, undefined);
  assert.equal(ui.tasks.length, 0);
});

/** A closing editor must release its cross-window lock after the task reports termination. */
test("shutdown waits for the installation task and removes its lock", async t => {
  const { root, setup } = await fixture(t);
  let started;
  const ready = new Promise(resolve => { started = resolve; });
  replace(t, installation, "inspectGlobal", async () => ({ path: join(root, "eska"), version: "0.11.0", compatible: true, selfUpdate: true }));
  replace(t, installation, "checkUpdate", async () => ({ version: "0.11.1", method: "installer" }));
  replace(t, vscode.tasks, "executeTask", async () => {
    const execution = { terminate() {
      setImmediate(() => { for (const listener of [...endListeners]) listener({ execution }); });
    } };
    started();
    return execution;
  });
  ui.approved = true;
  const updating = setup.check(true);
  await ready;
  await setup.shutdown();
  await updating;
  await assert.rejects(access(join(root, ".eska/.explorer-install.lock")));
  assert.equal(processListeners.size + endListeners.size, 0);
  assert.equal(ui.errors.length, 0);
});

/** Network checks have no authority to stop a working metadata connection. */
test("network failure stays quiet in the background and never disconnects", async t => {
  const { root, setup, events } = await fixture(t);
  replace(t, installation, "inspectGlobal", async () => ({ path: join(root, "eska"), version: "0.11.0", compatible: true, selfUpdate: true }));
  replace(t, installation, "checkUpdate", async () => { throw new Error("network unavailable"); });
  await setup.check(false);
  assert.deepEqual(events, []);
  assert.equal(ui.tasks.length + ui.errors.length, 0);
  await setup.check(true);
  assert.equal(ui.errors.length, 1);
  assert.deepEqual(events, []);
});

/** A successful installer exit cannot hide an older CLI shadowing the new binary in PATH. */
test("an older copy remaining first in PATH prevents a false successful update", async t => {
  const { root, setup, events } = await fixture(t);
  replace(t, installation, "inspectGlobal", async () => ({ path: join(root, "first/eska"), version: "0.11.0", compatible: true, selfUpdate: true }));
  replace(t, installation, "checkUpdate", async () => ({ version: "0.11.1", method: "installer" }));
  ui.approved = true;
  await setup.check(true);
  assert.equal(ui.errors.length, 1);
  assert.deepEqual(events, ["disconnect"]);
  assert.equal(ui.tasks.length, 1);
  await assert.rejects(access(join(root, ".eska/.explorer-install.lock")));
});
