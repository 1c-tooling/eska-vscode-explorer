import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, chmod, rm, realpath } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { projectContract, analyzerContract, nativeTarget, analyzerAsset, ToolFailure } from "../out/tooling/contracts.js";
import { findTool, inspectProject, inspectAnalyzer, inspectProjectContract } from "../out/tooling/inspect.js";

/** A complete T97 contract identifies exactly the project component and its compiled target. */
function contract() {
  return { schema_version: 2, tool: "eska-project", target: "x86_64-unknown-linux-gnu", version: "0.14.3",
    config_schema: "designer-xml-3", bridge_schema: 1, metadata_api: { major: 1, minor: 12 } };
}

/** Assertions cover the declared flags actually used by check/configuration, not a list of names alone. */
function analyzer() {
  return { build_version: "0.4.0", contract_version: "3.5", cli: { commands: [
    { name: "lsp", args: [{ name: "mode", takes_value: true, values: ["auto", "stdio"] }] },
    { name: "check-config", args: [{ name: "config", required: true, takes_value: true }] },
    { name: "analyze", args: [{ name: "format", takes_value: true, values: ["console", "jsonl"] }] },
  ] } };
}

test("project compatibility checks complete fields, config, bridge and target independently of release number", () => {
  const value = contract();
  assert.deepEqual(projectContract(value), value);
  for (const [field, replacement] of [["schema_version", 1], ["tool", "eska"], ["version", "0.14.3-dev"],
    ["bridge_schema", 2], ["config_schema", "designer-xml-1"], ["config_schema", "designer-xml-2"], ["config_schema", "other"], ["metadata_api", { major: 1, minor: 11 }],
    ["metadata_api", { major: 2, minor: 12 }], ["target", "unknown"]]) {
    assert.throws(() => projectContract({ ...value, [field]: replacement }), ToolFailure);
  }
  assert.throws(() => projectContract({ ...value, extra: true }), ToolFailure);
  assert.throws(() => projectContract(value, "aarch64-apple-darwin"), ToolFailure);
});

test("analyzer contract rejects unsupported versions, incomplete commands and missing configuration flags", () => {
  assert.equal(analyzerContract(analyzer()), "0.4.0");
  for (const mutate of [value => { value.build_version = "0.3.2"; }, value => { value.contract_version = "3.4"; },
    value => { value.cli.commands[0].args = undefined; }, value => { value.cli.commands[1].args = []; },
    value => { value.cli.commands[0].args[0].values = ["auto"]; },
    value => { value.cli.commands[2].args[0].values = ["console"]; }]) {
    const value = analyzer(); mutate(value);
    assert.throws(() => analyzerContract(value), ToolFailure);
  }
});

test("native target selection does not invent upstream ARM Linux, Intel macOS or musl app assets", () => {
  assert.equal(nativeTarget("linux", "x64", false), "x86_64-unknown-linux-musl");
  assert.equal(nativeTarget("linux", "arm64"), "aarch64-unknown-linux-gnu");
  assert.equal(nativeTarget("darwin", "arm64"), "aarch64-apple-darwin");
  assert.equal(analyzerAsset(nativeTarget("linux", "x64")), "bsl-analyzer-app-linux-amd64");
  assert.equal(analyzerAsset(nativeTarget("win32", "x64")), "bsl-analyzer-app-windows-amd64.exe");
  for (const target of ["x86_64-unknown-linux-musl", "aarch64-unknown-linux-gnu", "x86_64-apple-darwin"]) {
    assert.throws(() => analyzerAsset(target), { code: "unsupportedTarget" });
  }
  assert.throws(() => nativeTarget("win32", "arm64"), { code: "unsupportedTarget" });
});

test("explicit paths never fall back while default discovery ignores workspace-relative PATH entries", async t => {
  const root = await mkdtemp(join(process.env.ESKA_TEST_ROOT ?? resolve("../eska-playground"), "explorer-tool-paths-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const bin = join(root, "managed");
  await mkdir(bin);
  const name = process.platform === "win32" ? "eska-project.exe" : "eska-project";
  const file = join(bin, name);
  await writeFile(file, "fixture"); await chmod(file, 0o755);
  assert.equal(await findTool("eska-project", "eska-project", bin, "."), await realpath(file));
  assert.equal(await findTool(join(root, "missing"), "eska-project", bin, bin), undefined);
  await assert.rejects(findTool("./eska-project", "eska-project", bin, bin), { code: "invalidExecutable" });
  assert.equal(await findTool("eska-project", "eska-project", join(root, "absent"), "."), undefined);
});

test("real project inspection negotiates its API and validates the installed contract without a project", {
  skip: !process.env.ESKA_TEST_BINARY,
}, async t => {
  const root = await mkdtemp(join(process.env.ESKA_TEST_ROOT ?? resolve("../eska-playground"), "explorer-tool-project-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = process.env.ESKA_TEST_BINARY;
  const info = await inspectProject(path, root, () => {});
  assert.equal(info.kind, "project"); assert.ok(info.version);
  const { runProbe } = await import("../out/installation.js");
  const expected = projectContract(JSON.parse((await runProbe(path, ["__tool-contract"], root, 10_000, 65536)).stdout));
  assert.deepEqual(await inspectProjectContract(path, root, expected, () => {}), info);
  await assert.rejects(inspectProject(path, root, () => {}, AbortSignal.abort()), { code: "cancelled" });
});

/** Discovery must not reject a usable API 1.12 executable before Connection can negotiate its optional features. */
test("project preflight accepts the minimum tree API without query support", { skip: process.platform === "win32" }, async t => {
  const root = await mkdtemp(join(process.env.ESKA_TEST_ROOT ?? resolve("../eska-playground"), "explorer-tool-api12-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, "eska-project");
  const peer = fileURLToPath(new URL("fake-backend.mjs", import.meta.url));
  await writeFile(path, `#!${process.execPath}\nprocess.argv[2] = "api12"; import(${JSON.stringify(peer)});\n`);
  await chmod(path, 0o755);
  assert.deepEqual(await inspectProject(path, root, () => {}), { kind: "project", path, version: "test" });
});

test("real analyzer inspection verifies both bounded processes against the pinned CLI contract", {
  skip: !process.env.ESKA_TEST_ANALYZER_BINARY,
}, async t => {
  const root = await mkdtemp(join(process.env.ESKA_TEST_ROOT ?? resolve("../eska-playground"), "explorer-tool-analyzer-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const info = await inspectAnalyzer(process.env.ESKA_TEST_ANALYZER_BINARY, root);
  assert.equal(info.version, "0.4.0"); assert.equal(info.kind, "analyzer");
  await assert.rejects(inspectAnalyzer(process.env.ESKA_TEST_ANALYZER_BINARY, root, AbortSignal.abort()), { code: "cancelled" });
});
