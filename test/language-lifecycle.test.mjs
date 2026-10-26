import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, chmod, rm } from "node:fs/promises";
import { once } from "node:events";
import { join, resolve } from "node:path";
import { LanguageProcess } from "../out/language/process.js";
import { cancellableChoice } from "../out/tooling/choice.js";
import { analysisContext, analyzerConfiguration } from "../out/language/context.js";

/** Process fixtures stay in unique playground directories and never use a global temporary project. */
async function fixture(t) {
  const root = await mkdtemp(join(process.env.ESKA_TEST_ROOT ?? resolve("../eska-playground"), "explorer-language-"));
  t.after(() => rm(root, { recursive: true, force: true })); return root;
}

test("cancelled dialogs settle shutdown while late choices and rejections stay obsolete", async () => {
  const controller = new AbortController(); let resolve;
  const pending = cancellableChoice(new Promise(done => { resolve = done; }), controller.signal);
  controller.abort(); assert.equal(await pending, undefined); resolve("late install");
  assert.equal(await cancellableChoice(Promise.reject(new Error("closed dialog")), AbortSignal.abort()), undefined);
  await new Promise(done => setTimeout(done, 0));
});

test("language context accepts only versioned DTOs and leases for the exact current configuration", () => {
  const root = resolve("../eska-playground/context-dto"), path = value => ({ value, encoding: "utf-8" });
  const context = { schema_version: 1, kind: "project-context", status: "ready", context: { root: path(root), name: null, limited_context: false,
    sources: [{ root: path(root), source: path(join(root, "src")), descriptor: path("Configuration.xml"), member: null, role: "configuration", project_type: "configuration" }] } };
  assert.equal(analysisContext(context).root, root);
  assert.equal(analysisContext(context).sources[0].descriptor, join(root, "src", "Configuration.xml"));
  for (const descriptor of [path("../outside.xml"), path(root), undefined]) {
    assert.throws(() => analysisContext({ ...context, context: { ...context.context,
      sources: [{ ...context.context.sources[0], descriptor }] } }));
  }
  assert.throws(() => analysisContext({ ...context, schema_version: 2 }));
  assert.throws(() => analysisContext({ ...context, context: { ...context.context, root: path("relative") } }));
  const config = { schema_version: 1, kind: "analyzer-configuration", status: "current", path: path(join(root, "bsl-analyzer.toml")), preview_token: "a".repeat(64),
    ownership: { schema_version: 1, generator_version: 1, analyzer_version: "0.4.0", context: null, input_fingerprint: "b".repeat(64), body_sha256: "c".repeat(64) }, leaseId: "d".repeat(64) };
  assert.equal(analyzerConfiguration(config).lease, config.leaseId);
  assert.throws(() => analyzerConfiguration({ ...config, status: "stale" }));
  assert.throws(() => analyzerConfiguration({ ...config, ownership: { ...config.ownership, analyzer_version: "0.3.2" } }),
    { code: "analyzerVersionMismatch", details: { backendAnalyzer: "0.3.2", expectedAnalyzer: "0.4.0" } });
  assert.throws(() => analyzerConfiguration({ ...config, ownership: { ...config.ownership, analyzer_version: null } }), { code: "protocolInvalid" });
  assert.throws(() => analyzerConfiguration({ ...config, preview_token: "invalid", ownership: { ...config.ownership, analyzer_version: "0.3.2" } }), { code: "protocolInvalid" });
});

test("owned server cancellation reaps a peer which ignores normal termination", { skip: process.platform === "win32", timeout: 15000 }, async t => {
  const root = await fixture(t), file = join(root, "server");
  await writeFile(file, `#!${process.execPath}\nprocess.on('SIGTERM',()=>{});process.stdout.write('ready');setInterval(()=>{},500);\n`);
  await chmod(file, 0o755);
  const controller = new AbortController(), owner = new LanguageProcess(file, root, () => {}, () => {}, controller.signal);
  t.after(() => owner.stop()); await once(owner.child.stdout, "data");
  const pid = owner.child.pid; controller.abort(); await owner.stop();
  assert.equal(owner.child.signalCode, "SIGKILL");
  assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
});

test("owned server explicitly selects stdio instead of the upstream shared backend", { skip: process.platform === "win32" }, async t => {
  const root = await fixture(t), file = join(root, "server"), logs = [];
  await writeFile(file, `#!${process.execPath}\nprocess.stdout.write(JSON.stringify(process.argv.slice(2)));\n`);
  await chmod(file, 0o755);
  const owner = new LanguageProcess(file, root, value => logs.push(value), () => {});
  t.after(() => owner.stop());
  const chunks = [];
  owner.child.stdout.on("data", chunk => chunks.push(chunk));
  await owner.closed;
  const expected = ["lsp", "--mode", "stdio"];
  assert.deepEqual(JSON.parse(Buffer.concat(chunks).toString("utf8")), expected);
  assert.deepEqual(JSON.parse(logs.find(value => value.includes("language_process_start"))).args, expected);
});

test("spawn failure and an already cancelled startup cannot leave an owned child", async t => {
  const root = await fixture(t), missing = join(root, "missing");
  assert.throws(() => new LanguageProcess(missing, root, () => {}, () => {}, AbortSignal.abort()), { code: "cancelled" });
  const owner = new LanguageProcess(missing, root, () => {}, () => {});
  await owner.stop(); assert.equal(owner.child.pid, undefined);
});
