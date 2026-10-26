import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { once } from "node:events";
import { chmod, mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { strictJson, relativePath, installationLock, fileHash, recoverAbandonedClaim } from "../out/tooling/files.js";
import { installProject, installAnalyzer, managedPath, managedVersion } from "../out/tooling/install.js";
import { hostTarget, parseRelease } from "../out/tooling/releases.js";
import { runProbe } from "../out/installation.js";
import { projectPackage, unpackProject } from "../out/tooling/archive.js";
import { publishTransaction, cleanStage, restoreTransaction } from "../out/tooling/transaction.js";

const run = promisify(execFile), repository = fileURLToPath(new URL("../", import.meta.url));
const pythonTools = process.env.ESKA_TEST_PYTHON_TOOLS ?? resolve(repository, "../eska/tools");

/** Each scenario owns one unique playground directory and removes only that directory. */
async function fixture(t) {
  const path = await mkdtemp(join(process.env.ESKA_TEST_ROOT ?? resolve(repository, "../eska-playground"), "explorer-install-"));
  t.after(() => rm(path, { recursive: true, force: true }));
  return path;
}

/** Test archives use Python's independent ZIP writer, with real executable bytes for native acceptance. */
async function archive(root, binary, contract) {
  const payload = await readFile(binary), notice = Buffer.from("Fixture notice\n");
  const files = [{ path: "bin/eska-project", sha256: createHash("sha256").update(payload).digest("hex"), size: payload.length, executable: true },
    { path: "licenses/LICENSE", sha256: createHash("sha256").update(notice).digest("hex"), size: notice.length, executable: false }];
  const value = { schema_version: 1, tool: "eska-project", version: contract.version, target: contract.target, contract, files };
  const metadata = join(root, "package.json"), license = join(root, "LICENSE"), output = join(root, "component.zip");
  await writeFile(metadata, JSON.stringify(value)); await writeFile(license, notice);
  await run("python3", ["-B", "-c", "import sys,zipfile\nwith zipfile.ZipFile(sys.argv[1],'w',compression=zipfile.ZIP_DEFLATED) as z:\n z.write(sys.argv[2],'package.json')\n z.write(sys.argv[3],'bin/eska-project')\n z.write(sys.argv[4],'licenses/LICENSE')", output, metadata, binary, license]);
  const data = await readFile(output), sha256 = createHash("sha256").update(data).digest("hex");
  return { data, output, release: { kind: "project", version: value.version, target: value.target, asset: { name: "fixture.zip", url: "https://example.invalid/fixture.zip", size: data.length, sha256 } } };
}

test("strict JSON and portable paths reject ambiguous installation instructions", () => {
  assert.deepEqual(strictJson('{"a":[{"b":1},true,null,"x"]}'), { a: [{ b: 1 }, true, null, "x"] });
  for (const text of ['{"a":1,"a":2}', '{"a":{"x":1,"\\u0078":2}}', '['.repeat(66) + '0' + ']'.repeat(66)]) assert.throws(() => strictJson(text));
  for (const path of ["../x", "bin//x", "C:/x", "bin\\x", "bin/CON.txt", "licenses/x.", "licenses/x "]) assert.throws(() => relativePath(path));
});

test("release selection never substitutes the monolith or an unverified analyzer version/asset", () => {
  const target = hostTarget(), value = { draft: false, prerelease: false, tag_name: "v0.14.3", assets: [] };
  assert.match(parseRelease("project", target, value).restriction, /^missing-asset:/);
  assert.equal(parseRelease("analyzer", target, { ...value, tag_name: "v0.4.1" }).restriction, "supported-analyzer-0.4.0");
  const name = `eska-project-0.14.3-${target}.zip`;
  value.assets.push({ name, size: 1, state: "uploaded", digest: "sha256:" + "a".repeat(64), browser_download_url: `https://github.com/1c-tooling/eska/releases/download/v0.14.3/${name}` });
  assert.equal(parseRelease("project", target, value).asset.sha256, "a".repeat(64));
  value.assets[0].digest = null;
  assert.equal(parseRelease("project", target, value).restriction, "asset-integrity");
});

test("ZIP validation rejects traversal, links, undeclared members, lengths and corrupt payloads", async t => {
  const root = await fixture(t), binary = join(root, "fixture"); await writeFile(binary, "fixture");
  const contract = { schema_version: 2, tool: "eska-project", target: hostTarget(), version: "0.14.3", config_schema: "designer-xml-3", bridge_schema: 1, metadata_api: { major: 1, minor: 12 } };
  const packed = await archive(root, binary, contract);
  const program = "import json,sys,zipfile\nwith zipfile.ZipFile(sys.argv[1]) as z: items=[(i,z.read(i)) for i in z.infolist()]\nmode=sys.argv[3]\nwith zipfile.ZipFile(sys.argv[2],'w') as z:\n for info,data in items:\n  if info.filename=='package.json':\n   v=json.loads(data)\n   if mode=='length': v['files'][0]['size']+=1\n   if mode=='checksum': v['files'][0]['sha256']='0'*64\n   if mode=='schema': v['contract']['bridge_schema']=99\n   data=json.dumps(v).encode()\n  elif mode=='link' and info.filename.startswith('bin/'):\n   info.external_attr=0o120777<<16\n  z.writestr(info,data)\n if mode=='traversal': z.writestr('../escape',b'escape')\n if mode=='extra': z.writestr('extra',b'extra')\n if mode=='duplicate': z.writestr('package.json',b'{}')";
  for (const mode of ["traversal", "link", "extra", "length", "checksum", "schema", "duplicate"]) {
    const output = join(root, mode + ".zip");
    await run("python3", ["-B", "-c", program, packed.output, output, mode]);
    await assert.rejects(unpackProject(await readFile(output), join(root, "stage-" + mode), hostTarget()));
  }
  assert.equal(await fileHash(join(root, "escape")), null);
  assert.throws(() => strictJson(Buffer.from([0x7b, 0x22, 0xff, 0x22, 0x3a, 0x31, 0x7d])));
});

test("shared claim excludes Python and Node writers and cannot evict a live owner", async t => {
  const root = await fixture(t), prefix = join(root, "install");
  const program = "import sys\nsys.path.insert(0,sys.argv[1])\nfrom pathlib import Path\nfrom component_package import installation_lock\nwith installation_lock(Path(sys.argv[2])):\n print('locked',flush=True)\n input()";
  const child = spawn("python3", ["-B", "-c", program, pythonTools, prefix], { stdio: ["pipe", "pipe", "pipe"] });
  t.after(() => child.kill());
  await once(child.stdout, "data");
  await assert.rejects(installationLock(prefix, undefined, async () => {}), { code: "busy" });
  await assert.rejects(recoverAbandonedClaim(prefix), { code: "busy" });
  child.stdin.end("release\n"); await once(child, "close");
  await installationLock(prefix, undefined, async () => {
    const value = await run("python3", ["-B", "-c", "import sys\nsys.path.insert(0,sys.argv[1])\nfrom pathlib import Path\nfrom component_package import installation_lock,Failure\ntry:\n with installation_lock(Path(sys.argv[2])): print('unsafe')\nexcept Failure as e: print(e.code)", pythonTools, prefix]);
    assert.equal(value.stdout.trim(), "busy");
  });
  assert.equal((await readdir(prefix)).includes(".eska-components.claim"), false);
});

test("journal rollback restores every previous byte and retains all backups after an external conflict", async t => {
  const root = await fixture(t), prefix = join(root, "install");
  await mkdir(join(prefix, "bin"), { recursive: true });
  const file = join(prefix, "bin/eska-project"); await writeFile(file, "previous"); await chmod(file, 0o755);
  const old = new Map([["bin/eska-project", await fileHash(file)]]);
  for (const conflict of [false, true]) {
    const stage = await mkdtemp(join(prefix, ".eska-component-")), incoming = join(stage, "next"); await writeFile(incoming, "next");
    await assert.rejects(publishTransaction(prefix, stage, "eska-project", hostTarget(), old, new Map([["bin/eska-project", incoming]]), async () => {
      if (conflict) await writeFile(file, "external");
      throw new Error("injected verification failure");
    }), conflict ? { code: "recovery" } : /injected/);
    await cleanStage(stage);
    if (conflict) {
      assert.equal(await readFile(file, "utf8"), "external");
      await assert.rejects(restoreTransaction(prefix, stage, "eska-project", hostTarget()), { code: "recovery" });
      await writeFile(file, "next");
      await restoreTransaction(prefix, stage, "eska-project", hostTarget()); await cleanStage(stage);
    }
    assert.equal(await readFile(file, "utf8"), "previous");
  }
});

test("real project ZIP is shared with the Python CLI, preserves sibling files and reaps a cancelled probe", {
  skip: !process.env.ESKA_TEST_BINARY || process.platform === "win32",
  timeout: 30_000,
}, async t => {
  const root = await fixture(t), prefix = join(root, "install"), binary = process.env.ESKA_TEST_BINARY;
  const contract = JSON.parse((await runProbe(binary, ["__tool-contract"], root, 10_000, 65536)).stdout);
  const packed = await archive(root, binary, contract);
  assert.equal(projectPackage(JSON.parse(await readFile(join(root, "package.json"), "utf8"))).version, contract.version);
  await mkdir(join(prefix, "bin"), { recursive: true }); await writeFile(join(prefix, "bin/eska-vcs"), "unmanaged sibling");
  const info = await installProject(prefix, packed.data, packed.release, () => {});
  assert.equal(info.path, managedPath(prefix, "project")); assert.equal(info.version, contract.version);
  assert.equal(await readFile(join(prefix, "bin/eska-vcs"), "utf8"), "unmanaged sibling");
  const status = await run("python3", ["-B", join(pythonTools, "components.py"), "status", "--root", prefix, "--component", "eska-project", "--format", "json"]);
  assert.equal(JSON.parse(status.stdout).status, "installed");
  assert.equal(await managedVersion(prefix, "project"), contract.version);
  assert.equal((await installProject(prefix, packed.data, packed.release, () => {})).version, contract.version);
  await run("python3", ["-B", join(pythonTools, "components.py"), "remove", "--root", prefix, "--component", "eska-project", "--format", "json"]);
  assert.equal(await fileHash(info.path), null);
  await run("python3", ["-B", join(pythonTools, "components.py"), "install", "--root", prefix, "--archive", packed.output, "--sha256", packed.release.asset.sha256, "--format", "json"]);
  assert.equal((await installProject(prefix, packed.data, packed.release, () => {})).version, contract.version);
  const modified = Buffer.concat([await readFile(info.path), Buffer.from("changed")]);
  await writeFile(info.path, modified);
  await assert.rejects(installProject(prefix, packed.data, packed.release, () => {}), { code: "modified" });
  assert.deepEqual(await readFile(info.path), modified);
  const cancelled = new AbortController(), empty = join(root, "cancelled"); let probeStarted = false;
  await assert.rejects(installProject(empty, packed.data, packed.release, event => {
    if (event.includes('"event":"process_start"')) { probeStarted = true; queueMicrotask(() => cancelled.abort()); }
  }, cancelled.signal));
  assert.equal(probeStarted, true);
  assert.equal(await fileHash(managedPath(empty, "project")), null);
  assert.deepEqual((await readdir(empty)).filter(name => name.startsWith(".eska-component")), []);
});

test("reinstall keeps the staging working directory alive through both delayed project probes", {
  skip: !process.env.ESKA_TEST_BINARY || process.platform === "win32", timeout: 30000,
}, async t => {
  const root = await fixture(t), prefix = join(root, "install"), wrapper = join(root, "delayed-project");
  const python = (await run("python3", ["-c", "import sys; print(sys.executable)"])).stdout.trim();
  const binary = process.env.ESKA_TEST_BINARY;
  await writeFile(wrapper, `#!${python}\nimport os,sys,time\ntime.sleep(.1)\nos.execv(${JSON.stringify(binary)},[${JSON.stringify(binary)},*sys.argv[1:]])\n`, { mode: 0o755 });
  const contract = JSON.parse((await runProbe(wrapper, ["__tool-contract"], root, 10000, 65536)).stdout);
  const packed = await archive(root, wrapper, contract);
  const first = await installProject(prefix, packed.data, packed.release, () => {});
  assert.deepEqual(await installProject(prefix, packed.data, packed.release, () => {}), first);
  assert.deepEqual((await readdir(prefix)).filter(name => name.startsWith(".eska-component")), []);
});

test("real upstream app installs independently and verifies all five notices without replacing project", {
  skip: !process.env.ESKA_TEST_ANALYZER_BINARY,
}, async t => {
  const root = await fixture(t), prefix = join(root, "install"), data = await readFile(process.env.ESKA_TEST_ANALYZER_BINARY);
  await mkdir(join(prefix, "bin"), { recursive: true }); await writeFile(join(prefix, "bin/eska-project"), "custom project");
  const release = { kind: "analyzer", version: "0.4.0", target: hostTarget(), asset: { name: "upstream-fixture", url: "https://example.invalid/analyzer", sha256: createHash("sha256").update(data).digest("hex"), size: data.length } };
  const info = await installAnalyzer(prefix, data, release, join(repository, "resources/analyzer-notices"));
  assert.equal(info.path, managedPath(prefix, "analyzer")); assert.equal(info.version, "0.4.0");
  assert.equal(await readFile(join(prefix, "bin/eska-project"), "utf8"), "custom project");
  assert.equal(await managedVersion(prefix, "analyzer"), "0.4.0");
  assert.equal((await installAnalyzer(prefix, data, release, join(repository, "resources/analyzer-notices"))).version, "0.4.0");
  await writeFile(info.path, "user modification");
  await assert.rejects(installAnalyzer(prefix, data, release, join(repository, "resources/analyzer-notices")), { code: "modified" });
});
