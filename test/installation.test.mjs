import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile, chmod, rm, realpath, readFile } from "node:fs/promises";
import { join, resolve, delimiter } from "node:path";
import { compareVersions, findGlobal, parseRelease, checkUpdate, assertCargoRelease, runProbe, fetchText } from "../out/installation.js";
import { parseHandshake, API_VERSION, MAX_HEADER, MAX_REQUEST, MAX_RESPONSE } from "../out/protocol.js";

/** Installation checks use only their own disposable prefix under the shared playground. */
async function fixture(t) {
  const root = await mkdtemp(join(process.env.ESKA_TEST_ROOT ?? resolve("../eska-playground"), "explorer-install-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

test("stable release selection rejects preview versions, foreign installers and malformed numeric versions", () => {
  const release = { tag_name: "v0.11.1", draft: false, prerelease: false, assets: [
    { name: "eska-installer.sh", browser_download_url: "https://github.com/1c-tooling/eska/releases/download/v0.11.1/eska-installer.sh" },
    { name: "eska-installer.ps1", browser_download_url: "https://github.com/1c-tooling/eska/releases/download/v0.11.1/eska-installer.ps1" },
  ] };
  assert.equal(parseRelease(release, "linux").version, "0.11.1");
  assert.ok(parseRelease(release, "win32").installer.endsWith(".ps1"));
  assert.equal(compareVersions("0.11.10", "0.11.2"), 1);
  for (const version of ["0.11.1-rc.1", "0.11.1;echo", "0.11.01", "0.11.9007199254740992"]) assert.throws(() => compareVersions(version, "0.11.0"));
  for (const bad of [{ ...release, draft: true }, { ...release, prerelease: true }, { ...release, assets: [] },
    { ...release, assets: [{ name: "eska-installer.sh", browser_download_url: "https://example.com/install.sh" }] }]) {
    assert.throws(() => parseRelease(bad, "linux"));
  }
});

test("global discovery preserves PATH priority and finds a newly installed user CLI without relative PATH lookup", async t => {
  const root = await fixture(t);
  const first = join(root, "first/bin"), second = join(root, ".eska/bin");
  for (const dir of [first, second]) { await mkdir(dir, { recursive: true }); await writeFile(join(dir, "eska"), "fixture"); await chmod(join(dir, "eska"), 0o755); }
  assert.equal(await findGlobal(first, root, "linux"), await realpath(join(first, "eska")));
  await rm(join(first, "eska"));
  await mkdir(join(first, "eska"));
  assert.equal(await findGlobal(first, root, "linux"), await realpath(join(second, "eska")));
  assert.equal(await findGlobal(`.${delimiter}relative`, root, "linux"), await realpath(join(second, "eska")));
  await rm(join(second, "eska"));
  assert.equal(await findGlobal("", root, "linux"), undefined);
});

/** Read-only probes must not outlive either their deadline or extension deactivation. */
test("read-only probes reap SIGTERM-resistant processes on timeout and cancellation", { skip: process.platform === "win32" }, async t => {
  const root = await fixture(t);
  for (const cancel of [false, true]) {
    const pidFile = join(root, `probe-${cancel}.pid`);
    const controller = new AbortController();
    const pending = runProbe(process.execPath, ["-e", 'require("node:fs").writeFileSync(process.argv[1], String(process.pid)); process.on("SIGTERM",()=>{}); setInterval(()=>{},1000)', pidFile],
      root, 3000, 1024, controller.signal);
    const rejected = assert.rejects(pending);
    let pid;
    for (let attempt = 0; attempt < 400; attempt++) {
      try { pid = Number(await readFile(pidFile, "utf8")); break; } catch { await new Promise(resolve => setTimeout(resolve, 5)); }
    }
    assert.ok(pid);
    if (cancel) controller.abort();
    await rejected;
    assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
  }
});

/** Oversized and interrupted downloads cannot reach an installer or leave the reader open. */
test("downloads reject HTTP failures, oversized bodies and cancellation", async t => {
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; });
  let cancelled = false;
  globalThis.fetch = async () => new Response(new ReadableStream({ cancel() { cancelled = true; } }), { status: 503 });
  await assert.rejects(fetchText("https://example.invalid", 10), { code: "updateFailed" });
  assert.equal(cancelled, true);
  globalThis.fetch = async () => new Response("12345678901");
  await assert.rejects(fetchText("https://example.invalid", 10), { code: "updateFailed" });
  globalThis.fetch = async (_url, { signal }) => { signal.throwIfAborted(); return new Response("unused"); };
  const controller = new AbortController(); controller.abort();
  await assert.rejects(fetchText("https://example.invalid", 10, controller.signal));
});

test("native CLI update checks validate status, method and version before displaying an update", { skip: process.platform === "win32" }, async t => {
  const root = await fixture(t);
  const path = join(root, "eska");
  const cli = { path, version: "0.11.0", compatible: true, selfUpdate: true };
  const script = async result => {
    await writeFile(path, `#!${process.execPath}\nprocess.stdout.write(${JSON.stringify(JSON.stringify(result))});\n`);
    await chmod(path, 0o755);
  };
  await script({ schemaVersion: 1, status: "update-available", method: "cargo", availableVersion: "0.11.1" });
  assert.deepEqual(await checkUpdate(cli), { version: "0.11.1", method: "cargo" });
  await script({ schemaVersion: 1, status: "up-to-date", method: "installer", availableVersion: "0.11.0" });
  assert.equal((await checkUpdate(cli)).version, undefined);
  await script({ schemaVersion: 2, status: "update-available", method: "cargo", availableVersion: "0.11.1" });
  await assert.rejects(checkUpdate(cli));
});

test("compatible API major still requires search and file-event support", () => {
  const hello = { apiVersion: API_VERSION, server: { name: "eska", version: "0.11.0" },
    capabilities: { designerXml: true, readOnly: true, multiContext: false, search: true, clientFileEvents: true },
    limits: { maxHeaderBytes: MAX_HEADER, maxRequestBytes: MAX_REQUEST, maxResponseBytes: MAX_RESPONSE } };
  assert.equal(parseHandshake(hello), "0.11.0");
  for (const capability of ["search", "clientFileEvents"]) assert.throws(() => parseHandshake({ ...hello, capabilities: { ...hello.capabilities, [capability]: false } }), { code: "incompatible" });
});

/** Yanked, unpublished and future-schema entries cannot approve a Cargo installation. */
test("Cargo publication is read from the sparse index and rejects unusable entries", () => {
  const index = [
    { name: "eska", vers: "0.11.1", yanked: false },
    { name: "eska", vers: "0.11.2", yanked: true },
    { name: "eska", vers: "0.11.3", yanked: false, v: 3 },
    { name: "other", vers: "0.11.4", yanked: false },
  ].map(entry => JSON.stringify(entry)).join("\n") + "\n";
  assert.doesNotThrow(() => assertCargoRelease(index, "0.11.1"));
  for (const version of ["0.11.2", "0.11.3", "0.11.4", "0.11.5", "0.11.1-rc.1"]) assert.throws(() => assertCargoRelease(index, version));
  assert.throws(() => assertCargoRelease("broken", "0.11.1"));
  assert.throws(() => assertCargoRelease("", "0.11.1"));
});
