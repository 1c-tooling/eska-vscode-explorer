/** Install real release assets with the same verification and receipts as Explorer. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { appendFile, copyFile, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { downloadAsset, fetchBytes, hostTarget, parseRelease } from "../out/tooling/releases.js";
import { installAnalyzer, installComponent } from "../out/tooling/install.js";
import { inspectAnalyzer } from "../out/tooling/inspect.js";

const repository = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const playground = resolve(process.env.ESKA_TEST_ROOT ?? join(repository, "../eska-playground"));
const root = await mkdtemp(join(playground, "explorer-release-backends-"));
const prefix = join(root, "installation"), pythonTools = join(root, "python-tools");
await mkdir(pythonTools);
const target = hostTarget(), local = process.argv[2] && resolve(process.argv[2]);
let projectRelease, projectData;
const bootstrap = ["components.py", "component_installation.py", "component_package.py"];
if (local) {
  const index = JSON.parse(await readFile(join(local, "release.json"), "utf8"));
  const item = index.components["eska-project"];
  assert.equal(index.target, target);
  projectRelease = { kind: "project", target, version: index.version,
    asset: { name: item.archive, size: item.size, sha256: item.sha256, url: "https://example.invalid/local-build" } };
  projectData = await readFile(join(local, item.archive));
  for (const name of bootstrap) await copyFile(join(local, name), join(pythonTools, name));
} else {
  const release = JSON.parse(await fetchBytes("https://api.github.com/repos/odineska/eska/releases/latest", 4 * 1024 * 1024));
  projectRelease = parseRelease("project", target, release);
  assert.ok(projectRelease.asset, `ESKA release cannot be installed: ${projectRelease.restriction}`);
  projectData = await downloadAsset(projectRelease.asset);
  for (const name of bootstrap) {
    const candidates = release.assets.filter(asset => asset.name === name);
    assert.equal(candidates.length, 1, `Missing release bootstrap: ${name}`);
    const asset = candidates[0];
    assert.equal(asset.state, "uploaded");
    assert.match(asset.digest, /^sha256:[a-f0-9]{64}$/);
    assert.equal(asset.browser_download_url, `https://github.com/odineska/eska/releases/download/${release.tag_name}/${name}`);
    const data = await downloadAsset({ name, url: asset.browser_download_url, size: asset.size, sha256: asset.digest.slice(7) });
    await writeFile(join(pythonTools, name), data);
  }
}
const project = await installComponent(prefix, projectData, projectRelease, () => {});
assert.deepEqual(await installComponent(prefix, projectData, projectRelease, () => {}), project);
let analyzerRelease, analyzerData;
if (local && process.env.ESKA_TEST_ANALYZER_BINARY) {
  const info = await inspectAnalyzer(process.env.ESKA_TEST_ANALYZER_BINARY, root);
  analyzerData = await readFile(process.env.ESKA_TEST_ANALYZER_BINARY);
  analyzerRelease = { kind: "analyzer", target, version: info.version, asset: { name: "local-upstream",
    url: "https://example.invalid/local-upstream", size: analyzerData.length, sha256: createHash("sha256").update(analyzerData).digest("hex") } };
} else {
  const metadata = await fetchBytes("https://api.github.com/repos/itrous/bsl-analyzer/releases/latest", 4 * 1024 * 1024);
  analyzerRelease = parseRelease("analyzer", target, JSON.parse(metadata));
  assert.ok(analyzerRelease.asset, `Analyzer release cannot be installed: ${analyzerRelease.restriction}`);
  analyzerData = await downloadAsset(analyzerRelease.asset);
}
const analyzer = await installAnalyzer(prefix, analyzerData, analyzerRelease, join(repository, "resources/analyzer-notices"));
assert.deepEqual(await installAnalyzer(prefix, analyzerData, analyzerRelease, join(repository, "resources/analyzer-notices")), analyzer);
const environment = { ESKA_TEST_ROOT: playground, ESKA_TEST_BINARY: project.path,
  ESKA_TEST_ANALYZER_BINARY: analyzer.path, ESKA_TEST_PYTHON_TOOLS: pythonTools, ESKA_TEST_LANGUAGE: "1" };
await writeFile(join(root, "environment.json"), JSON.stringify(environment, null, 2) + "\n");
if (process.env.GITHUB_ENV) {
  for (const [name, value] of Object.entries(environment)) {
    assert.ok(!/[\r\n]/.test(value));
    await appendFile(process.env.GITHUB_ENV, `${name}=${value}\n`);
  }
}
console.log(JSON.stringify({ root, project: project.version, analyzer: analyzer.version, environment }));
