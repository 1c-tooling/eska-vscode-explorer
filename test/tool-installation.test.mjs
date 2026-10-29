import { deferCleanup } from "./cleanup.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { once } from "node:events";
import { chmod, copyFile, mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { strictJson, relativePath, installationLock, fileHash, recoverAbandonedClaim } from "../out/tooling/files.js";
import { installComponent, installAnalyzer, managedPath, managedVersion } from "../out/tooling/install.js";
import { hostTarget, parseRelease } from "../out/tooling/releases.js";
import { analyzerAsset } from "../out/tooling/contracts.js";
import { runProbe } from "../out/installation.js";
import { componentPackage, unpackComponent } from "../out/tooling/archive.js";
import { publishTransaction, cleanStage, restoreTransaction } from "../out/tooling/transaction.js";

const run = promisify(execFile), repository = fileURLToPath(new URL("../", import.meta.url));
const pythonTools = process.env.ESKA_TEST_PYTHON_TOOLS ?? resolve(repository, "../eska/tools");
const python = process.env.ESKA_TEST_PYTHON ?? (process.platform === "win32" ? "python" : "python3");

/** Each scenario owns one unique playground directory and removes only that directory. */
async function fixture(t) {
  const path = await mkdtemp(join(process.env.ESKA_TEST_ROOT ?? resolve(repository, "../eska-playground"), "explorer-install-каталог-😀-"));
  deferCleanup(t, () => rm(path, { recursive: true, force: true }));
  return path;
}

/** Test archives use Python's independent ZIP writer, with real executable bytes for native acceptance. */
async function archive(root, binary, contract) {
  const payload = await readFile(binary), notice = Buffer.from("Fixture notice\n");
  const executable = `${contract.tool}${contract.target.includes("windows") ? ".exe" : ""}`;
  const files = [{ path: `bin/${executable}`, sha256: createHash("sha256").update(payload).digest("hex"), size: payload.length, executable: true },
    { path: "licenses/LICENSE", sha256: createHash("sha256").update(notice).digest("hex"), size: notice.length, executable: false }];
  const value = { schema_version: 1, tool: contract.tool, version: contract.version, target: contract.target, contract, files };
  const metadata = join(root, "package.json"), license = join(root, "LICENSE"), output = join(root, "component.zip");
  await writeFile(metadata, JSON.stringify(value)); await writeFile(license, notice);
  await run(python, ["-B", "-c", "import sys,zipfile\nwith zipfile.ZipFile(sys.argv[1],'w',compression=zipfile.ZIP_DEFLATED) as z:\n z.write(sys.argv[2],'package.json')\n z.write(sys.argv[3],'bin/'+sys.argv[5])\n z.write(sys.argv[4],'licenses/LICENSE')", output, metadata, binary, license, executable]);
  const data = await readFile(output), sha256 = createHash("sha256").update(data).digest("hex");
  return { data, output, release: { kind: contract.tool === "eska-fmt" ? "formatter" : "project", version: value.version, target: value.target, asset: { name: "fixture.zip", url: "https://example.invalid/fixture.zip", size: data.length, sha256 } } };
}

test("strict JSON and portable paths reject ambiguous installation instructions", () => {
  assert.deepEqual(strictJson('{"a":[{"b":1},true,null,"x"]}'), { a: [{ b: 1 }, true, null, "x"] });
  for (const text of ['{"a":1,"a":2}', '{"a":{"x":1,"\\u0078":2}}', '['.repeat(66) + '0' + ']'.repeat(66)]) assert.throws(() => strictJson(text));
  for (const path of ["../x", "bin//x", "C:/x", "bin\\x", "bin/CON.txt", "licenses/x.", "licenses/x "]) assert.throws(() => relativePath(path));
});

test("release selection never substitutes the monolith or an unverified analyzer version/asset", () => {
  const target = hostTarget(), value = { draft: false, prerelease: false, tag_name: "v0.14.3", assets: [] };
  assert.match(parseRelease("project", target, value).restriction, /^missing-asset:/);
  const asset = analyzerAsset(target);
  for (const version of ["0.4.1", "0.5.0", "1.2.3"]) {
    const release = parseRelease("analyzer", target, { ...value, tag_name: `v${version}`, assets: [{ name: asset, size: 1,
      state: "uploaded", digest: "sha256:" + "b".repeat(64),
      browser_download_url: `https://github.com/itrous/bsl-analyzer/releases/download/v${version}/${asset}` }] });
    assert.equal(release.version, version);
    assert.equal(release.asset.sha256, "b".repeat(64));
    assert.equal(release.restriction, undefined);
  }
  const name = `eska-project-0.14.3-${target}.zip`;
  value.assets.push({ name, size: 1, state: "uploaded", digest: "sha256:" + "a".repeat(64), browser_download_url: `https://github.com/odineska/eska/releases/download/v0.14.3/${name}` });
  assert.equal(parseRelease("project", target, value).asset.sha256, "a".repeat(64));
  const officialUrl = value.assets[0].browser_download_url;
  for (const owner of ["1c-tooling", "unrelated-owner"]) {
    value.assets[0].browser_download_url = officialUrl.replace("/odineska/", `/${owner}/`);
    assert.equal(parseRelease("project", target, value).restriction, "asset-integrity");
  }
  value.assets[0].browser_download_url = officialUrl;
  value.assets[0].digest = null;
  assert.equal(parseRelease("project", target, value).restriction, "asset-integrity");
});

test("ZIP validation rejects traversal, links, undeclared members, lengths and corrupt payloads", async t => {
  const root = await fixture(t), binary = join(root, "fixture"); await writeFile(binary, "fixture");
  const contract = { schema_version: 2, tool: "eska-project", target: hostTarget(), version: "0.14.3", config_schema: "designer-xml-4", bridge_schema: 1, metadata_api: { major: 1, minor: 12 } };
  const packed = await archive(root, binary, contract);
  const valid = await unpackComponent(packed.data, join(root, "valid"), hostTarget());
  assert.deepEqual(await readFile(join(root, "valid", valid.files[0].path)), await readFile(binary));
  const program = "import json,sys,zipfile\nwith zipfile.ZipFile(sys.argv[1]) as z: items=[(i,z.read(i)) for i in z.infolist()]\nmode=sys.argv[3]\nwith zipfile.ZipFile(sys.argv[2],'w') as z:\n for info,data in items:\n  if info.filename=='package.json':\n   v=json.loads(data)\n   if mode=='length': v['files'][0]['size']+=1\n   if mode=='checksum': v['files'][0]['sha256']='0'*64\n   if mode=='schema': v['contract']['bridge_schema']=99\n   data=json.dumps(v).encode()\n  elif mode=='link' and info.filename.startswith('bin/'):\n   info.external_attr=0o120777<<16\n  z.writestr(info,data)\n if mode=='traversal': z.writestr('../escape',b'escape')\n if mode=='extra': z.writestr('extra',b'extra')\n if mode=='duplicate': z.writestr('package.json',b'{}')";
  for (const mode of ["traversal", "link", "extra", "length", "checksum", "schema", "duplicate"]) {
    const output = join(root, mode + ".zip");
    await run(python, ["-B", "-c", program, packed.output, output, mode]);
    await assert.rejects(unpackComponent(await readFile(output), join(root, "stage-" + mode), hostTarget()));
  }
  assert.equal(await fileHash(join(root, "escape")), null);
  assert.throws(() => strictJson(Buffer.from([0x7b, 0x22, 0xff, 0x22, 0x3a, 0x31, 0x7d])));
});

test("shared claim excludes Python and Node writers and cannot evict a live owner", async t => {
  const root = await fixture(t), prefix = join(root, "install");
  const program = "import sys\nsys.path.insert(0,sys.argv[1])\nfrom pathlib import Path\nfrom component_package import installation_lock\nwith installation_lock(Path(sys.argv[2])):\n print('locked',flush=True)\n input()";
  const child = spawn(python, ["-B", "-c", program, pythonTools, prefix], { stdio: ["pipe", "pipe", "pipe"] });
  deferCleanup(t, () => child.kill());
  await once(child.stdout, "data");
  await assert.rejects(installationLock(prefix, undefined, async () => {}), { code: "busy" });
  await assert.rejects(recoverAbandonedClaim(prefix), { code: "busy" });
  child.stdin.end("release\n"); await once(child, "close");
  await installationLock(prefix, undefined, async () => {
    const value = await run(python, ["-B", "-c", "import sys\nsys.path.insert(0,sys.argv[1])\nfrom pathlib import Path\nfrom component_package import installation_lock,Failure\ntry:\n with installation_lock(Path(sys.argv[2])): print('unsafe')\nexcept Failure as e: print(e.code)", pythonTools, prefix]);
    assert.equal(value.stdout.trim(), "busy");
  });
  assert.equal((await readdir(prefix)).includes(".eska-components.claim"), false);
});

test("journal rollback restores every previous byte and retains all backups after an external conflict", async t => {
  const root = await fixture(t), prefix = join(root, "install");
  await mkdir(join(prefix, "bin"), { recursive: true });
  const name = `bin/eska-project${process.platform === "win32" ? ".exe" : ""}`;
  const file = join(prefix, name); await writeFile(file, "previous"); await chmod(file, 0o755);
  const old = new Map([[name, await fileHash(file)]]);
  for (const conflict of [false, true]) {
    const stage = await mkdtemp(join(prefix, ".eska-component-")), incoming = join(stage, "next"); await writeFile(incoming, "next");
    await assert.rejects(publishTransaction(prefix, stage, "eska-project", hostTarget(), old, new Map([[name, incoming]]), async () => {
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
  skip: !process.env.ESKA_TEST_BINARY,
  timeout: 120_000,
}, async t => {
  const root = await fixture(t), prefix = join(root, "install"), binary = process.env.ESKA_TEST_BINARY;
  const contract = JSON.parse((await runProbe(binary, ["__tool-contract"], root, 10_000, 65536)).stdout);
  const packed = await archive(root, binary, contract);
  assert.equal(componentPackage(JSON.parse(await readFile(join(root, "package.json"), "utf8"))).version, contract.version);
  await mkdir(join(prefix, "bin"), { recursive: true }); await writeFile(join(prefix, "bin/eska-vcs"), "unmanaged sibling");
  const info = await installComponent(prefix, packed.data, packed.release, () => {});
  assert.equal(info.path, managedPath(prefix, "project")); assert.equal(info.version, contract.version);
  assert.equal(await readFile(join(prefix, "bin/eska-vcs"), "utf8"), "unmanaged sibling");
  const status = await run(python, ["-B", join(pythonTools, "components.py"), "status", "--root", prefix, "--component", "eska-project", "--format", "json"]);
  assert.equal(JSON.parse(status.stdout).status, "installed");
  assert.equal(await managedVersion(prefix, "project"), contract.version);
  assert.equal((await installComponent(prefix, packed.data, packed.release, () => {})).version, contract.version);
  await run(python, ["-B", join(pythonTools, "components.py"), "remove", "--root", prefix, "--component", "eska-project", "--format", "json"]);
  assert.equal(await fileHash(info.path), null);
  await run(python, ["-B", join(pythonTools, "components.py"), "install", "--root", prefix, "--archive", packed.output, "--sha256", packed.release.asset.sha256, "--format", "json"]);
  assert.equal((await installComponent(prefix, packed.data, packed.release, () => {})).version, contract.version);
  const modified = Buffer.concat([await readFile(info.path), Buffer.from("changed")]);
  await writeFile(info.path, modified);
  await assert.rejects(installComponent(prefix, packed.data, packed.release, () => {}), { code: "modified" });
  assert.deepEqual(await readFile(info.path), modified);
  const cancelled = new AbortController(), empty = join(root, "cancelled"); let probeStarted = false;
  await assert.rejects(installComponent(empty, packed.data, packed.release, event => {
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
  const pythonExecutable = (await run(python, ["-c", "import sys; print(sys.executable)"])).stdout.trim();
  const binary = process.env.ESKA_TEST_BINARY;
  await writeFile(wrapper, `#!${pythonExecutable}\nimport os,sys,time\ntime.sleep(.1)\nos.execv(${JSON.stringify(binary)},[${JSON.stringify(binary)},*sys.argv[1:]])\n`, { mode: 0o755 });
  const contract = JSON.parse((await runProbe(wrapper, ["__tool-contract"], root, 10000, 65536)).stdout);
  const packed = await archive(root, wrapper, contract);
  const first = await installComponent(prefix, packed.data, packed.release, () => {});
  assert.deepEqual(await installComponent(prefix, packed.data, packed.release, () => {}), first);
  assert.deepEqual((await readdir(prefix)).filter(name => name.startsWith(".eska-component")), []);
});

test("real upstream app installs independently and verifies all five notices without replacing project", {
  skip: !process.env.ESKA_TEST_ANALYZER_BINARY,
}, async t => {
  const root = await fixture(t), prefix = join(root, "install"), data = await readFile(process.env.ESKA_TEST_ANALYZER_BINARY);
  const version = (await runProbe(process.env.ESKA_TEST_ANALYZER_BINARY, ["--version"], root, 10000, 65536)).stdout.trim().split(" ").at(-1);
  await mkdir(join(prefix, "bin"), { recursive: true }); await writeFile(join(prefix, "bin/eska-project"), "custom project");
  const release = { kind: "analyzer", version, target: hostTarget(), asset: { name: "upstream-fixture", url: "https://example.invalid/analyzer", sha256: createHash("sha256").update(data).digest("hex"), size: data.length } };
  const info = await installAnalyzer(prefix, data, release, join(repository, "resources/analyzer-notices"));
  assert.equal(info.path, managedPath(prefix, "analyzer")); assert.equal(info.version, version);
  assert.equal(await readFile(join(prefix, "bin/eska-project"), "utf8"), "custom project");
  assert.equal(await managedVersion(prefix, "analyzer"), version);
  assert.equal((await installAnalyzer(prefix, data, release, join(repository, "resources/analyzer-notices"))).version, version);
  await writeFile(info.path, "user modification");
  await assert.rejects(installAnalyzer(prefix, data, release, join(repository, "resources/analyzer-notices")), { code: "modified" });
});

/** Exercise the CI entry point under Node, including real installation and its exported environment. */
test("backend preparation installs native tools and exports verified paths for subsequent CI steps", {
  skip: !process.env.ESKA_TEST_BINARY || !process.env.ESKA_TEST_ANALYZER_BINARY,
  timeout: 180_000,
}, async t => {
  const root = await fixture(t), binary = process.env.ESKA_TEST_BINARY;
  const analyzerVersion = (await runProbe(process.env.ESKA_TEST_ANALYZER_BINARY, ["--version"], root, 10000, 65536)).stdout.trim().split(" ").at(-1);
  const contract = JSON.parse((await runProbe(binary, ["__tool-contract"], root, 10_000, 65536)).stdout);
  const packed = await archive(root, binary, contract), githubEnv = join(root, "github-env");
  await writeFile(join(root, "release.json"), JSON.stringify({ version: contract.version, target: contract.target,
    components: { "eska-project": { archive: "component.zip", size: packed.data.length, sha256: packed.release.asset.sha256 } } }));
  const bootstrap = ["components.py", "component_installation.py", "component_package.py"];
  for (const name of bootstrap) await copyFile(join(pythonTools, name), join(root, name));
  const { stdout } = await run("node", [join(repository, "scripts/prepare-backends.mjs"), root], {
    cwd: repository, env: { ...process.env, ESKA_TEST_ROOT: root, GITHUB_ENV: githubEnv }, timeout: 120_000,
  });
  const prepared = JSON.parse(stdout), prefix = join(prepared.root, "installation"), environment = prepared.environment;
  assert.equal(prepared.project, contract.version); assert.equal(prepared.analyzer, analyzerVersion);
  assert.equal(environment.ESKA_TEST_ROOT, root);
  assert.equal(environment.ESKA_TEST_BINARY, managedPath(prefix, "project"));
  assert.equal(environment.ESKA_TEST_ANALYZER_BINARY, managedPath(prefix, "analyzer"));
  assert.equal(environment.ESKA_TEST_LANGUAGE, "1");
  assert.equal(await managedVersion(prefix, "project"), contract.version);
  assert.equal(await managedVersion(prefix, "analyzer"), analyzerVersion);
  assert.deepEqual(JSON.parse(await readFile(join(prepared.root, "environment.json"), "utf8")), environment);
  assert.equal(await readFile(githubEnv, "utf8"), Object.entries(environment).map(([name, value]) => `${name}=${value}\n`).join(""));
  for (const name of bootstrap) assert.deepEqual(await readFile(join(environment.ESKA_TEST_PYTHON_TOOLS, name)), await readFile(join(root, name)));
});

/** The real optional formatter archive uses the same producer/receipt boundary as the project component. */
test("formatter archive installs alone, round-trips Python ownership and preserves its project sibling", { skip: !process.env.ESKA_TEST_FMT_BINARY || !process.env.ESKA_TEST_BINARY }, async t => {
  const root = await fixture(t), prefix = join(root, "selected");
  const formatter = process.env.ESKA_TEST_FMT_BINARY;
  const contract = JSON.parse((await runProbe(formatter, ["__tool-contract"], root, 10_000, 65536)).stdout);
  const packed = await archive(root, formatter, contract);
  assert.equal(componentPackage(JSON.parse(await readFile(join(root,"package.json"),"utf8")), hostTarget(), "eska-fmt").tool,"eska-fmt");
  const info = await installComponent(prefix, packed.data, packed.release, () => {});
  assert.equal(info.kind, "formatter"); assert.equal(info.path, managedPath(prefix,"formatter"));
  assert.equal(await managedVersion(prefix,"formatter"), contract.version);
  assert.equal(await fileHash(join(prefix,"bin/eska-project")),null);
  const receipt = JSON.parse(await readFile(join(prefix,"components/eska-fmt.json"),"utf8"));
  const prior = await fileHash(info.path), receiptHash = await fileHash(join(prefix,"components/eska-fmt.json"));
  const project = process.env.ESKA_TEST_BINARY, projectContract = JSON.parse((await runProbe(project,["__tool-contract"],root,10_000,65536)).stdout);
  const sibling = await archive(root,project,projectContract);
  await installComponent(prefix,sibling.data,sibling.release,()=>{});
  assert.equal(await fileHash(info.path),prior); assert.equal(await fileHash(join(prefix,"components/eska-fmt.json")),receiptHash);
  await installComponent(prefix,packed.data,packed.release,()=>{});
  assert.deepEqual(JSON.parse(await readFile(join(prefix,"components/eska-fmt.json"),"utf8")),receipt);
  const inspected = await run(python,["-B",join(pythonTools,"components.py"),"status","--component","eska-fmt","--root",prefix,"--format","json"]);
  assert.deepEqual(JSON.parse(inspected.stdout).contract,contract);
});

/** Missing formatter assets remain a formatter-specific restriction without selecting the analyzer or a bundle. */
test("formatter release selects only the exact independent asset", () => {
  const target=hostTarget(),name=`eska-fmt-0.18.0-${target}.zip`;
  const release={draft:false,prerelease:false,tag_name:"v0.18.0",assets:[]};
  assert.equal(parseRelease("formatter",target,release).restriction,`missing-asset:${name}`);
  release.assets.push({name,size:100,state:"uploaded",digest:"sha256:"+"a".repeat(64),browser_download_url:`https://github.com/odineska/eska/releases/download/v0.18.0/${name}`});
  assert.equal(parseRelease("formatter",target,release).asset.name,name);
});
