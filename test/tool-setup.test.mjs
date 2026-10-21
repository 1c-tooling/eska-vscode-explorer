import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { runInNewContext } from "node:vm";

const require = createRequire(import.meta.url), os = require("node:os");
const releases = require("../out/tooling/releases.js"), installation = require("../out/tooling/install.js");
const ui = { approved: false, cancelled: false, messages: [], settings: {}, bars: [] };
const vscode = {
  env: { language: "en-US", remoteName: undefined },
  workspace: { isTrusted: true, getConfiguration() { return { get(key, fallback) { return ui.settings[key] ?? fallback; } }; } },
  StatusBarAlignment: { Right: 1 }, ProgressLocation: { Notification: 1 },
  window: {
    createStatusBarItem(id) { const bar = { id, show() { this.visible = true; }, dispose() { this.disposed = true; } }; ui.bars.push(bar); return bar; },
    async showInformationMessage(text, action) { ui.messages.push(text); return ui.approved ? action : undefined; },
    async showWarningMessage(text, action) { ui.messages.push(text); return ui.approved ? action : undefined; },
    async showErrorMessage(text) { ui.messages.push(text); },
    async withProgress(_options, task) { return task({}, { isCancellationRequested: ui.cancelled, onCancellationRequested() { return { dispose() {} }; } }); },
  },
};
const adapter = { exports: {} }, setupRequire = createRequire(new URL("../out/tooling/setup.js", import.meta.url));
runInNewContext(`(function(require,module,exports){${readFileSync(new URL("../out/tooling/setup.js", import.meta.url), "utf8")}\n})`, { AbortController, AbortSignal, process, Date })(
  name => name === "vscode" ? vscode : setupRequire(name), adapter, adapter.exports);
const { ToolingSetup } = adapter.exports;

/** Mocks replace only orchestration boundaries; binary/archive behavior is exercised in tool-installation tests. */
function replace(t, object, key, value) { const prior = object[key]; object[key] = value; t.after(() => { object[key] = prior; }); }

/** No UI test reads or mutates the user's global installation or persistent update timestamps. */
async function fixture(t) {
  const home = await mkdtemp(join(process.env.ESKA_TEST_ROOT ?? resolve("../eska-playground"), "explorer-tool-ui-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  replace(t, os, "homedir", () => home);
  ui.approved = false; ui.cancelled = false; ui.messages = []; ui.settings = {}; ui.bars = [];
  const timestamps = new Map(), requests = [], actions = [];
  const setup = new ToolingSetup({ extensionPath: resolve("."), globalState: {
    get(key, fallback) { return timestamps.get(key) ?? fallback; }, async update(key, value) { timestamps.set(key, value); },
  } }, () => {}, () => {}, async kind => actions.push(["stop", kind]), async kind => actions.push(["restart", kind]));
  t.after(() => setup.shutdown());
  replace(t, installation, "managedVersion", async (_root, kind) => kind === "project" ? "0.14.3" : "0.3.2");
  replace(t, releases, "latestToolRelease", async kind => { requests.push(kind); return { kind, version: kind === "project" ? "0.14.3" : "0.3.2", target: releases.hostTarget() }; });
  return { setup, timestamps, requests, actions };
}

test("two status items use separate identities and never replace a selected version with an available one", async t => {
  const { setup } = await fixture(t);
  setup.states.analyzer.info = { kind: "analyzer", version: "0.3.2", path: join(setup.root, "custom-analyzer") };
  setup.states.analyzer.available = "0.3.3";
  setup.analyzerState("suspended", "foreign-extension");
  assert.match(setup.analyzerStatus.text, /^BSL Analyzer v0\.3\.2 · suspended$/);
  assert.equal(setup.analyzerStatus.command, "eska.explorer.checkAnalyzerUpdates");
  assert.match(setup.analyzerStatus.tooltip, /custom-analyzer/);
  assert.match(setup.analyzerStatus.tooltip, /Available release: 0.3.3/);
  assert.equal(setup.analyzerStatus.visible, true);
  await setup.check("analyzer");
  assert.equal(setup.states.analyzer.phase, "suspended");
  assert.match(setup.analyzerStatus.text, /v0\.3\.2 · suspended/);
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
  replace(t, installation, "installProject", async root => { installed++; return { kind: "project", version: "0.14.3", path: installation.managedPath(root, "project") }; });
  replace(t, installation, "installAnalyzer", async () => assert.fail("unselected analyzer updated"));
  setup.states.project.info = { kind: "project", version: "0.14.2", path: installation.managedPath(setup.root, "project") };
  setup.states.analyzer.info = { kind: "analyzer", version: "0.3.2", path: join(setup.root, "custom-analyzer") };
  ui.approved = true;
  await setup.check("project");
  assert.equal(installed, 1); assert.deepEqual(actions, [["stop", "project"], ["restart", "project"]]);
  assert.equal(setup.states.project.info.version, "0.14.3"); assert.equal(setup.states.analyzer.info.version, "0.3.2");
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
  replace(t, releases, "latestToolRelease", async kind => ({ kind, version: "0.3.2", target, asset: { name: "analyzer", sha256: "b".repeat(64), size: 1, url: "https://example.invalid/analyzer" } }));
  replace(t, releases, "downloadAsset", async (_asset, signal) => { signal.throwIfAborted(); return Buffer.from("candidate"); });
  replace(t, installation, "installAnalyzer", async root => ({ kind: "analyzer", version: "0.3.2", path: installation.managedPath(root, "analyzer") }));
  replace(t, installation, "installProject", async () => assert.fail("unselected project updated"));
  setup.states.analyzer.info = { kind: "analyzer", version: "0.3.2", path: installation.managedPath(setup.root, "analyzer") };
  setup.analyzerState("suspended", "foreign-extension"); ui.approved = true;
  await setup.check("analyzer");
  assert.deepEqual(actions, [["stop", "analyzer"], ["restart", "analyzer"]]);
  assert.equal(setup.states.analyzer.phase, "suspended");
  assert.match(setup.analyzerStatus.text, /^BSL Analyzer v0\.3\.2 · suspended$/);
  actions.length = 0; ui.cancelled = true;
  await setup.check("analyzer");
  assert.deepEqual(actions, []); assert.equal(setup.states.analyzer.info.version, "0.3.2");
  assert.equal(setup.states.analyzer.phase, "suspended");
});

test("a conflict arriving during an independent update retains its current reason and state", async t => {
  const { setup } = await fixture(t), target = releases.hostTarget();
  replace(t, installation, "managedVersion", async () => undefined);
  replace(t, releases, "latestToolRelease", async kind => ({ kind, version: "0.3.2", target, asset: { name: "analyzer", sha256: "b".repeat(64), size: 1, url: "https://example.invalid/analyzer" } }));
  replace(t, releases, "downloadAsset", async () => { setup.analyzerState("suspended-conflict", "enabled inactive foreign client"); return Buffer.from("candidate"); });
  replace(t, installation, "installAnalyzer", async root => ({ kind: "analyzer", version: "0.3.2", path: installation.managedPath(root, "analyzer") }));
  setup.states.analyzer.info = { kind: "analyzer", version: "0.3.2", path: installation.managedPath(setup.root, "analyzer") };
  setup.analyzerState("ready"); ui.approved = true;
  await setup.check("analyzer");
  assert.equal(setup.states.analyzer.phase, "suspended-conflict"); assert.equal(setup.states.analyzer.detail, "enabled inactive foreign client");
  assert.match(setup.analyzerStatus.tooltip, /enabled inactive foreign client/);
});

test("a missing selected analyzer clears its previous version without hiding an extension conflict", async t => {
  const { setup } = await fixture(t);
  setup.states.analyzer.info = { kind: "analyzer", version: "0.3.2", path: join(setup.root, "old-analyzer") };
  setup.analyzerState("suspended-conflict", "foreign extension");
  ui.settings.analyzerExecutable = join(setup.root, "missing-analyzer");
  assert.equal(await setup.ensureAnalyzer(undefined, false), undefined);
  assert.equal(setup.states.analyzer.info, undefined);
  assert.equal(setup.states.analyzer.phase, "suspended-conflict");
  assert.ok(!setup.analyzerStatus.text.includes("v0.3.2"));
  assert.match(setup.analyzerStatus.tooltip, /foreign extension/);
});

test("a failed binary probe updates the visible version while keeping the conflict reason", { skip: process.platform === "win32" }, async t => {
  const { setup } = await fixture(t), invalid = join(setup.root, "invalid-analyzer");
  await mkdir(setup.root);
  await writeFile(invalid, "#!/bin/sh\nexit 1\n", { mode: 0o755 });
  setup.states.analyzer.info = { kind: "analyzer", version: "0.3.2", path: join(setup.root, "old-analyzer") };
  setup.analyzerState("suspended-conflict", "foreign extension");
  ui.settings.analyzerExecutable = invalid;
  await assert.rejects(setup.ensureAnalyzer(undefined, false));
  assert.equal(setup.states.analyzer.info, undefined);
  assert.equal(setup.states.analyzer.phase, "suspended-conflict");
  assert.ok(!setup.analyzerStatus.text.includes("v0.3.2"));
  assert.match(setup.analyzerStatus.tooltip, /foreign extension/);
});
