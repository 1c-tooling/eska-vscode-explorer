import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runProbe } from "../out/installation.js";
import { hostTarget, latestToolRelease, downloadAsset } from "../out/tooling/releases.js";
import { installAnalyzer, installComponent } from "../out/tooling/install.js";

const repository = fileURLToPath(new URL("../", import.meta.url));
const playground = process.env.ESKA_TEST_ROOT ?? resolve(repository, "../eska-playground");
const binary = process.env.ESKA_TEST_BINARY, archive = process.env.ESKA_TEST_PROJECT_ARCHIVE;
if (!isAbsolute(playground) || !binary || !isAbsolute(binary) || !archive || !isAbsolute(archive)) {
  throw new Error("Set absolute ESKA_TEST_ROOT, ESKA_TEST_BINARY (project) and ESKA_TEST_PROJECT_ARCHIVE (T97 ZIP).");
}
const root = await mkdtemp(join(playground, "t85-installation-")), prefix = join(root, "managed");
const contract = JSON.parse((await runProbe(binary, ["__tool-contract"], root, 10_000, 65536)).stdout);
// The installer and installed tools must work without Cargo, Python, Git, ESKA or a platform in PATH.
process.env.PATH = "";
const target = hostTarget(), proposals = await Promise.all([latestToolRelease("project", target), latestToolRelease("analyzer", target)]);
const analyzerRelease = proposals[1];
assert.ok(analyzerRelease.asset && !analyzerRelease.restriction);
const projectData = await readFile(archive), sha256 = createHash("sha256").update(projectData).digest("hex");
const projectRelease = { kind: "project", version: contract.version, target, asset: { name: "local-T97.zip", url: "https://example.invalid/local", size: projectData.length, sha256 } };
const project = await installComponent(prefix, projectData, projectRelease, () => {});
const analyzerData = await downloadAsset(analyzerRelease.asset);
const analyzer = await installAnalyzer(prefix, analyzerData, analyzerRelease, join(repository, "resources/analyzer-notices"));
const projectRepeat = await installComponent(prefix, projectData, projectRelease, () => {});
const analyzerRepeat = await installAnalyzer(prefix, analyzerData, analyzerRelease, join(repository, "resources/analyzer-notices"));
assert.deepEqual(project, projectRepeat); assert.deepEqual(analyzer, analyzerRepeat);
assert.deepEqual(await readdir(join(prefix, "bin")), [process.platform === "win32" ? "eska-project.exe" : "eska-project"]);
assert.deepEqual(await readdir(join(prefix, "analyzer", "bin")), [process.platform === "win32" ? "bsl-analyzer-app.exe" : "bsl-analyzer-app"]);
const report = { schema_version: 1, platform: process.platform, architecture: process.arch, node: process.versions.node,
  target, prefix, path: process.env.PATH, project, analyzer, project_source: { archive, sha256 },
  public_releases: proposals, analyzer_download_sha256: createHash("sha256").update(analyzerData).digest("hex"),
  local_repeat_equal: true, limitation: "Project ZIP is local T97 output; a missing public asset is recorded without substituting the monolith." };
await writeFile(join(root, "report.json"), JSON.stringify(report, null, 2) + "\n");
console.log(JSON.stringify({ root, report: join(root, "report.json"), project: project.version, analyzer: analyzer.version }));
