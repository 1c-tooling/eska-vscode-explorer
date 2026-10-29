import { deferCleanup } from "./cleanup.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { runInNewContext } from "node:vm";

const require = createRequire(import.meta.url), os = require("node:os");
const releases = require("../out/tooling/releases.js"), installation = require("../out/tooling/install.js");
const bundle = require("../out/tooling/bundle.js");
const globalInstallation = require("../out/installation.js"), inspection = require("../out/tooling/inspect.js");
const updateTask = { async runUpdateTask() { assert.fail("unexpected bundle task"); } };
const originalManagedVersion = installation.managedVersion, originalLatestToolRelease = releases.latestToolRelease;
const ui = { approved: false, cancelled: false, messages: [], settings: {}, bars: [], picks: [], choices: [], commands: [] };
const vscode = {
  env: { language: "en-US", remoteName: undefined },
  workspace: { isTrusted: true, getConfiguration() { return { get(key, fallback) { return ui.settings[key] ?? fallback; } }; } },
  StatusBarAlignment: { Right: 1 }, ProgressLocation: { Notification: 1 },
  commands: { async executeCommand(command) { ui.commands.push(command); } },
  window: {
    createStatusBarItem(id) { const bar = { id, show() { this.visible = true; }, dispose() { this.disposed = true; } }; ui.bars.push(bar); return bar; },
    async showQuickPick(items, options) { ui.picks.push({ items, options }); const choice = ui.choices.shift(); return choice === undefined ? undefined : items.find(item => item.component === choice || item.command === choice); },
    async showInformationMessage(text, action) { ui.messages.push(text); return ui.approved ? action : undefined; },
    async showWarningMessage(text, action) { ui.messages.push(text); return ui.approved ? action : undefined; },
    async showErrorMessage(text) { ui.messages.push(text); },
    async withProgress(_options, task) { return task({}, { isCancellationRequested: ui.cancelled, onCancellationRequested() { return { dispose() {} }; } }); },
  },
};
const adapter = { exports: {} }, setupRequire = createRequire(new URL("../out/tooling/setup.js", import.meta.url));
runInNewContext(`(function(require,module,exports){${readFileSync(new URL("../out/tooling/setup.js", import.meta.url), "utf8")}\n})`, { AbortController, AbortSignal, process, Date })(
  name => name === "vscode" ? vscode : name === "./update-task.js" ? updateTask : setupRequire(name), adapter, adapter.exports);
const { ToolingSetup } = adapter.exports;
const restorations = new WeakMap();

/** Restore nested overrides in reverse order so no UI mock escapes into real installation tests. */
function replace(t, object, key, value) {
  let saved = restorations.get(t);
  if (!saved) {
    saved = [];
    restorations.set(t, saved);
    deferCleanup(t, () => { for (const restore of saved.reverse()) restore(); });
  }
  const prior = object[key];
  saved.push(() => { object[key] = prior; });
  object[key] = value;
}

/** No UI test reads or mutates the user's global installation or persistent update timestamps. */
async function fixture(t) {
  const home = await mkdtemp(join(process.env.ESKA_TEST_ROOT ?? resolve("../eska-playground"), "explorer-tool-ui-"));
  deferCleanup(t, () => rm(home, { recursive: true, force: true }));
  replace(t, os, "homedir", () => home);
  ui.approved = false; ui.cancelled = false; ui.messages = []; ui.settings = {}; ui.bars = []; ui.picks = []; ui.choices = []; ui.commands = [];
  const timestamps = new Map(), requests = [], actions = [], terminalPaths = [];
  const setup = new ToolingSetup({ extensionPath: resolve("."), environmentVariableCollection: { prepend(...args) { terminalPaths.push(args); } }, globalState: {
    get(key, fallback) { return timestamps.get(key) ?? fallback; }, async update(key, value) { timestamps.set(key, value); },
  } }, () => {}, () => {}, async kind => actions.push(["stop", kind]), async kind => actions.push(["restart", kind]));
  deferCleanup(t, () => setup.shutdown());
  replace(t, installation, "managedVersion", async (_root, kind) => kind === "project" ? "0.14.3" : "0.4.0");
  replace(t, releases, "latestToolRelease", async kind => { requests.push(kind); return { kind, version: kind === "project" ? "0.14.3" : "0.4.0", target: releases.hostTarget() }; });
  return { setup, timestamps, requests, actions, terminalPaths };
}

test("first project setup offers the full CLI and populates PATH after approval in both locales", async t => {
  for (const language of ["en-US", "ru-RU"]) {
    const { setup, terminalPaths } = await fixture(t);
    replace(t, vscode.env, "language", language);
    replace(t, inspection, "findTool", async () => undefined);
    replace(t, globalInstallation, "latestRelease", async () => ({ version: "0.19.0", installer: "official-installer" }));
    let installed = 0, executed = 0;
    replace(t, bundle, "bootstrapBundle", async (root, _release, execute) => {
      installed++;
      await execute({ executable: "powershell.exe", args: ["-File", "installer.ps1"], cwd: root, env: { ESKA_INSTALL_DIR: join(root, "bin") } });
      return { kind: "project", version: "0.19.0", path: join(root, "bin", "eska-project") };
    });
    replace(t, updateTask, "runUpdateTask", async (command, args, _title, _signal, options) => {
      executed++;
      assert.equal(command, "powershell.exe"); assert.deepEqual(args, ["-File", "installer.ps1"]);
      assert.equal(options.env.ESKA_INSTALL_DIR, join(setup.root, "bin"));
    });
    const signal = new AbortController().signal;
    assert.equal(await setup.ensureProject(signal, "eska-project"), undefined);
    assert.equal(installed, 0);
    ui.approved = true;
    assert.equal(await setup.ensureProject(signal, "eska-project"), join(setup.root, "bin", "eska-project"));
    assert.equal(installed, 1); assert.equal(executed, 1);
    assert.equal(terminalPaths[0][0], "PATH");
    assert.ok(terminalPaths[0][1].startsWith(join(setup.root, "bin")));
    assert.ok(ui.messages.some(text => /PATH/.test(text) && /fmt/.test(text)));
  }
});

test("component state stays independent while the single status tooltip preserves selected and available versions", async t => {
  const { setup } = await fixture(t);
  setup.states.analyzer.info = { kind: "analyzer", version: "0.4.0", path: join(setup.root, "custom-analyzer") };
  setup.states.analyzer.available = "0.4.1";
  setup.analyzerState("suspended", "foreign-extension");
  assert.equal(ui.bars.length, 0, "components do not create status items");
  assert.match(setup.summary(), /custom-analyzer/);
  assert.match(setup.summary(), /Available release: 0.4.1/);
  await setup.check("analyzer");
  assert.equal(setup.states.analyzer.phase, "suspended");
  assert.equal(setup.states.analyzer.info.version, "0.4.0");
});

test("daily checks, disabled settings and manual checks are independent for each host component", async t => {
  const { setup, timestamps, requests } = await fixture(t);
  ui.settings.checkForUpdates = false;
  await Promise.all([setup.background("project"), setup.background("analyzer"), setup.background("analyzer")]);
  assert.deepEqual(requests, ["analyzer"]);
  assert.equal(timestamps.size, 1);
  assert.match([...timestamps.keys()][0], /^toolUpdateChecked\.analyzer\.local\./);
  await setup.background("analyzer"); assert.equal(requests.length, 1);
  await setup.check("project"); await setup.check("analyzer");
  assert.deepEqual(requests, ["analyzer", "project", "analyzer"]);
  ui.settings.checkForUpdates = true;
  await Promise.all([setup.background("project"), setup.background("project")]);
  assert.equal(requests.filter(kind => kind === "project").length, 2);
  assert.equal(timestamps.size, 2);
});

test("a blocked or failed check never suppresses its peer or clears the language suspension", async t => {
  const { setup, requests } = await fixture(t);
  let release;
  replace(t, releases, "latestToolRelease", async kind => {
    requests.push(kind);
    if (kind === "analyzer") return new Promise((_resolve, reject) => { release = () => reject(new Error("network failure")); });
    return { kind, version: "0.14.3", target: releases.hostTarget() };
  });
  setup.analyzerState("suspended");
  const pending = setup.check("analyzer");
  await setup.check("project");
  assert.deepEqual(requests, ["analyzer", "project"]);
  assert.equal(setup.states.analyzer.phase, "suspended");
  release(); await pending;
  assert.equal(setup.states.analyzer.phase, "suspended");
  assert.match(ui.messages.at(-1), /failed/);
});

test("approved project updates stop and restart only the selected managed component", async t => {
  const { setup, actions } = await fixture(t), target = releases.hostTarget();
  replace(t, installation, "managedVersion", async () => "0.14.2");
  replace(t, releases, "latestToolRelease", async kind => ({ kind, version: "0.14.3", target, asset: { name: "component", sha256: "a".repeat(64), size: 1, url: "https://example.invalid/component" } }));
  replace(t, releases, "downloadAsset", async (_asset, signal) => { assert.equal(signal.aborted, false); return Buffer.from("candidate"); });
  let installed = 0;
  replace(t, installation, "installComponent", async root => { installed++; return { kind: "project", version: "0.14.3", path: installation.managedPath(root, "project") }; });
  replace(t, installation, "installAnalyzer", async () => assert.fail("unselected analyzer updated"));
  setup.states.project.info = { kind: "project", version: "0.14.2", path: installation.managedPath(setup.root, "project") };
  setup.states.analyzer.info = { kind: "analyzer", version: "0.4.0", path: join(setup.root, "custom-analyzer") };
  ui.approved = true;
  await setup.check("project");
  assert.equal(installed, 1); assert.deepEqual(actions, [["stop", "project"], ["restart", "project"]]);
  assert.equal(setup.states.project.info.version, "0.14.3"); assert.equal(setup.states.analyzer.info.version, "0.4.0");
  setup.states.project.info = { kind: "project", version: "custom-dev", path: join(setup.root, "custom-project") };
  actions.length = 0;
  await setup.check("project");
  assert.equal(installed, 2); assert.deepEqual(actions, []);
  assert.equal(setup.states.project.info.version, "custom-dev");
  assert.ok(ui.messages.some(text => text.includes("custom-project") && text.includes("managed installation")));
});

test("analyzer update and cancellation preserve a suspended client's ownership and actual version", async t => {
  const { setup, actions } = await fixture(t), target = releases.hostTarget();
  replace(t, installation, "managedVersion", async () => undefined);
  replace(t, releases, "latestToolRelease", async kind => ({ kind, version: "0.4.0", target, asset: { name: "analyzer", sha256: "b".repeat(64), size: 1, url: "https://example.invalid/analyzer" } }));
  replace(t, releases, "downloadAsset", async (_asset, signal) => { signal.throwIfAborted(); return Buffer.from("candidate"); });
  replace(t, installation, "installAnalyzer", async root => ({ kind: "analyzer", version: "0.4.0", path: installation.managedPath(root, "analyzer") }));
  replace(t, installation, "installComponent", async () => assert.fail("unselected project updated"));
  setup.states.analyzer.info = { kind: "analyzer", version: "0.4.0", path: installation.managedPath(setup.root, "analyzer") };
  setup.analyzerState("suspended", "foreign-extension"); ui.approved = true;
  await setup.check("analyzer");
  assert.deepEqual(actions, [["stop", "analyzer"], ["restart", "analyzer"]]);
  assert.equal(setup.states.analyzer.phase, "suspended");
  assert.equal(setup.states.analyzer.info.version, "0.4.0");
  actions.length = 0; ui.cancelled = true;
  await setup.check("analyzer");
  assert.deepEqual(actions, []); assert.equal(setup.states.analyzer.info.version, "0.4.0");
  assert.equal(setup.states.analyzer.phase, "suspended");
});

test("a conflict arriving during an independent update retains its current reason and state", async t => {
  const { setup } = await fixture(t), target = releases.hostTarget();
  replace(t, installation, "managedVersion", async () => undefined);
  replace(t, releases, "latestToolRelease", async kind => ({ kind, version: "0.4.0", target, asset: { name: "analyzer", sha256: "b".repeat(64), size: 1, url: "https://example.invalid/analyzer" } }));
  replace(t, releases, "downloadAsset", async () => { setup.analyzerState("suspended-conflict", "enabled inactive foreign client"); return Buffer.from("candidate"); });
  replace(t, installation, "installAnalyzer", async root => ({ kind: "analyzer", version: "0.4.0", path: installation.managedPath(root, "analyzer") }));
  setup.states.analyzer.info = { kind: "analyzer", version: "0.4.0", path: installation.managedPath(setup.root, "analyzer") };
  setup.analyzerState("ready"); ui.approved = true;
  await setup.check("analyzer");
  assert.equal(setup.states.analyzer.phase, "suspended-conflict"); assert.equal(setup.states.analyzer.detail, "enabled inactive foreign client");
  assert.match(setup.tooltip("analyzer"), /enabled inactive foreign client/);
});

test("a missing selected analyzer clears its previous version without hiding an extension conflict", async t => {
  const { setup } = await fixture(t);
  setup.states.analyzer.info = { kind: "analyzer", version: "0.4.0", path: join(setup.root, "old-analyzer") };
  setup.analyzerState("suspended-conflict", "foreign extension");
  ui.settings.analyzerExecutable = join(setup.root, "missing-analyzer");
  assert.equal(await setup.ensureAnalyzer(undefined, false), undefined);
  assert.equal(setup.states.analyzer.info, undefined);
  assert.equal(setup.states.analyzer.phase, "suspended-conflict");
  assert.equal(setup.states.analyzer.info, undefined);
  assert.match(setup.tooltip("analyzer"), /foreign extension/);
});

test("a failed binary probe updates the visible version while keeping the conflict reason", { skip: process.platform === "win32" }, async t => {
  const { setup } = await fixture(t), invalid = join(setup.root, "invalid-analyzer");
  await mkdir(setup.root);
  await writeFile(invalid, "#!/bin/sh\nexit 1\n", { mode: 0o755 });
  setup.states.analyzer.info = { kind: "analyzer", version: "0.4.0", path: join(setup.root, "old-analyzer") };
  setup.analyzerState("suspended-conflict", "foreign extension");
  ui.settings.analyzerExecutable = invalid;
  await assert.rejects(setup.ensureAnalyzer(undefined, false));
  assert.equal(setup.states.analyzer.info, undefined);
  assert.equal(setup.states.analyzer.phase, "suspended-conflict");
  assert.equal(setup.states.analyzer.info, undefined);
  assert.match(setup.tooltip("analyzer"), /foreign extension/);
});

test("UI scenarios restore shared module functions for following test files", () => {
  assert.equal(installation.managedVersion, originalManagedVersion);
  assert.equal(releases.latestToolRelease, originalLatestToolRelease);
});

for (const scenario of ["success", "failure", "custom", "declined", "current", "disconnected"]) {
  test(`cargo-dist project updates preserve the original channel and session: ${scenario}`, async t => {
    const { setup, actions } = await fixture(t);
    const update = { cli: join(setup.root, "bin/eska"), project: installation.managedPath(setup.root, "project"),
      version: "0.15.2", available: scenario === "current" ? "0.15.2" : "0.16.0", identity: "receipt-and-hashes" };
    const selected = scenario === "custom" ? join(setup.root, "custom-project") : update.project;
    if (scenario !== "disconnected") setup.states.project.info = { kind: "project", path: selected, version: "0.15.2" };
    setup.analyzerState("suspended-conflict", "foreign extension");
    replace(t, installation, "managedVersion", async () => undefined);
    replace(t, bundle, "inspectBundle", async () => update);
    replace(t, releases, "latestToolRelease", async () => assert.fail("bundle update queried component assets"));
    replace(t, releases, "downloadAsset", async () => assert.fail("bundle update downloaded component archive"));
    let installed = 0;
    replace(t, bundle, "installBundle", async (_root, candidate, execute) => {
      assert.equal(candidate, update); installed++;
      await execute(update.cli, ["update", "--target-version", update.available, "--format", "json"]);
      if (scenario === "failure") throw new Error("installer failed");
      return { kind: "project", path: update.project, version: update.available };
    });
    replace(t, updateTask, "runUpdateTask", async (cli, args) => {
      assert.equal(cli, update.cli); assert.deepEqual(args, ["update", "--target-version", "0.16.0", "--format", "json"]);
    });
    ui.approved = scenario !== "declined";
    await setup.check("project");
    const attempted = !["current", "declined"].includes(scenario);
    assert.equal(installed, attempted ? 1 : 0);
    assert.deepEqual(actions, scenario === "disconnected" ? [["restart", "project"]] : attempted && scenario !== "custom" ? [["stop", "project"], ["restart", "project"]] : []);
    assert.equal(setup.states.project.info.path, selected);
    assert.equal(setup.states.project.info.version, ["success", "disconnected"].includes(scenario) ? "0.16.0" : "0.15.2");
    assert.equal(setup.states.project.activity, undefined);
    assert.equal(setup.states.analyzer.phase, "suspended-conflict");
    assert.equal(setup.states.analyzer.detail, "foreign extension");
    if (scenario !== "current") assert.ok(ui.messages.some(text => text.includes("entire ESKA bundle") && text.includes(scenario === "disconnected" ? "not installed" : selected)));
    if (scenario === "failure") assert.ok(ui.messages.at(-1).includes("failed"));
  });
}

/** Formatter setup never probes, stops or installs the analyzer or metadata backend. */
test("formatter status, independent checks and discovery preserve other component states", async t => {
  const {setup, requests, actions}=await fixture(t);
  const inspect=require("../out/tooling/inspect.js");
  replace(t,inspect,"findTool",async (_configured,name)=> { assert.equal(name,"eska-fmt"); return "/owned/eska-fmt"; });
  replace(t,inspect,"inspectFormatter",async path=>({kind:"formatter",path,version:"0.18.0"}));
  const project=setup.states.project, analyzer=setup.states.analyzer;
  const info=await setup.ensureFormatter(undefined,false);
  assert.equal(info.kind,"formatter"); assert.equal(setup.states.project,project); assert.equal(setup.states.analyzer,analyzer);
  assert.equal(setup.states.formatter.info.version,"0.18.0");
  assert.match(setup.summary(),/eska-fmt/);
  assert.equal(ui.bars.length,0);
  await setup.background("formatter");
  assert.ok(requests.every(kind=>kind==="formatter")); assert.equal(actions.length,0);
});

/** Opening ESKA is read-only; only an explicit component action invokes an existing command. */
test("one component menu exposes all selected versions and routes every action without automatic update checks", async t => {
  const { setup, requests } = await fixture(t);
  for (const component of ["project", "formatter", "analyzer"]) {
    setup.states[component].info = { kind: component, version: "1.2.3", path: join(setup.root, component) };
    setup.states[component].available = "9.9.9";
  }
  const routes = { project: ["checkUpdates", "recoverProjectInstallation"], formatter: ["checkFormatterUpdates", "recoverFormatterInstallation"], analyzer: ["checkAnalyzerUpdates", "recoverAnalyzerInstallation"] };
  for (const [component, commands] of Object.entries(routes)) {
    for (const command of [...commands, "showLog"]) {
      ui.choices = [component, command];
      await setup.showComponents();
      assert.equal(ui.commands.at(-1), `eska.explorer.${command}`);
      const root = ui.picks.at(-2);
      assert.equal(root.options.title, "ESKA");
      assert.deepEqual(Array.from(root.items, item => item.component), ["project", "formatter", "analyzer"]);
      assert.ok(root.items.every(item => item.description.includes("v1.2.3") && !item.description.includes("9.9.9")));
      assert.equal(ui.picks.at(-1).options.title, `ESKA › ${root.items.find(item => item.component === component).label}`);
    }
  }
  assert.deepEqual(requests, []);
  ui.choices = []; const count = ui.commands.length; await setup.showComponents();
  ui.choices = ["formatter"]; await setup.showComponents();
  assert.equal(ui.commands.length, count, "cancel does not invoke an action");
});

test("one click updates project, formatter and Analyzer without component choices or install prompts", async t => {
  const { setup, requests, actions } = await fixture(t), installed = [];
  ui.settings = { checkForUpdates: false, checkForAnalyzerUpdates: false, checkForFormatterUpdates: false };
  replace(t, installation, "managedVersion", async () => "0.18.0");
  replace(t, releases, "latestToolRelease", async kind => {
    requests.push(kind);
    return { kind, version: "0.20.0", target: releases.hostTarget(), asset: { name: kind } };
  });
  replace(t, releases, "downloadAsset", async asset => { installed.push(asset.name); return Buffer.from("fixture"); });
  replace(t, installation, "installComponent", async (root, _data, release) => ({ kind: release.kind, path: installation.managedPath(root, release.kind), version: release.version }));
  replace(t, installation, "installAnalyzer", async root => ({ kind: "analyzer", path: installation.managedPath(root, "analyzer"), version: "0.20.0" }));
  const first = setup.updateAll(), duplicate = setup.updateAll();
  assert.equal(first, duplicate);
  await first;
  assert.deepEqual(requests, ["project", "formatter", "analyzer"]);
  assert.deepEqual(installed, requests);
  assert.deepEqual(ui.picks, []);
  assert.ok(!ui.messages.some(text => text.includes("?") || text.includes("managed version")));
  assert.deepEqual(actions, [["restart", "project"], ["restart", "formatter"], ["restart", "analyzer"]]);
  assert.ok(Object.values(setup.states).every(state => !state.activity));
});

test("one click updates the complete cargo-dist bundle and Analyzer without separately installing its formatter", async t => {
  const { setup, actions } = await fixture(t), installed = [];
  const update = { cli: join(setup.root, "bin/eska"), project: installation.managedPath(setup.root, "project"),
    version: "0.18.0", available: "0.20.0", identity: "receipt-and-hashes" };
  setup.states.project.info = { kind: "project", path: update.project, version: update.version };
  replace(t, installation, "managedVersion", async () => undefined);
  replace(t, bundle, "inspectBundle", async () => update);
  replace(t, bundle, "installBundle", async () => { installed.push("bundle"); return { kind: "project", path: update.project, version: update.available }; });
  replace(t, setup, "ensureFormatter", async () => { installed.push("inspect-formatter"); return undefined; });
  replace(t, releases, "latestToolRelease", async kind => {
    assert.equal(kind, "analyzer"); return { kind, version: "0.4.1", target: releases.hostTarget(), asset: { name: kind } };
  });
  replace(t, releases, "downloadAsset", async () => Buffer.from("fixture"));
  replace(t, installation, "installAnalyzer", async root => { installed.push("analyzer"); return { kind: "analyzer", path: installation.managedPath(root, "analyzer"), version: "0.4.1" }; });
  await setup.updateAll();
  assert.deepEqual(installed, ["bundle", "inspect-formatter", "analyzer"]);
  assert.deepEqual(ui.picks, []);
  assert.deepEqual(actions, [["stop", "project"], ["restart", "project"], ["restart", "analyzer"]]);
  assert.ok(!ui.messages.some(text => text.includes("?")));
});

test("an independent Analyzer update still runs after project update failure", async t => {
  const { setup, requests } = await fixture(t);
  replace(t, releases, "latestToolRelease", async kind => { requests.push(kind); if (kind === "project") throw new Error("network");
    return { kind, version: "0.4.0", target: releases.hostTarget() }; });
  await setup.updateAll();
  assert.deepEqual(requests, ["project", "formatter", "analyzer"]);
  assert.deepEqual(ui.picks, []);
  assert.ok(ui.messages.some(text => text.includes("failed")));
  assert.ok(!ui.messages.some(text => text.includes("are up to date")));
});

test("cancelling the shared update stops later components before their probes", async t => {
  const { setup, requests } = await fixture(t);
  ui.cancelled = true;
  await setup.updateAll();
  assert.deepEqual(requests, []);
  assert.deepEqual(ui.picks, []);
});
