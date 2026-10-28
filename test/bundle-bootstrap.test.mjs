import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { runInNewContext } from "node:vm";

const names = ["eska", "eska-project", "eska-check", "eska-build", "eska-vcs", "eska-fmt"];

/** Exercise the real prefix/receipt checks and executable probes inside an isolated user home. */
async function fixture(t) {
  const home = await mkdtemp(join(process.env.ESKA_TEST_ROOT ?? resolve("../eska-playground"), "explorer-bootstrap-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const root = join(home, ".eska"), metadata = join(home, "config"), require = createRequire(new URL("../out/tooling/bundle.js", import.meta.url));
  let disposed = 0, downloads = 0;
  const installation = { ...require("../installation.js"), async bootstrapCommand() {
    downloads++;
    return { executable: "/bin/sh", args: ["official-installer"], cwd: home, env: { ESKA_INSTALL_DIR: join(root, "bin") },
      async dispose() { disposed++; } };
  } };
  const module = { exports: {} };
  runInNewContext(`(function(require,module,exports){${readFileSync(new URL("../out/tooling/bundle.js", import.meta.url), "utf8")}\n})`, {
    process: { platform: process.platform, env: { AXOUPDATER_CONFIG_PATH: metadata } },
  })(name => name === "node:os" ? { homedir: () => home } : name === "../installation.js" ? installation
    : name === "./inspect.js" ? { async inspectProject(path) { return { kind: "project", path, version: "0.19.0" }; } } : require(name), module, module.exports);
  const release = { version: "0.19.0", installer: "https://github.com/1c-tooling/eska/releases/download/v0.19.0/eska-installer.sh" };
  const execute = async command => {
    assert.equal(command.env.ESKA_INSTALL_DIR, join(root, "bin"));
    await mkdir(join(root, "bin"), { recursive: true }); await mkdir(metadata);
    for (const name of names) await writeFile(join(root, "bin", name), `#!${process.execPath}\nconsole.log('${name} 0.19.0');\n`, { mode: 0o755 });
    await writeFile(join(metadata, "eska-receipt.json"), JSON.stringify({ binaries: names, install_layout: "flat", install_prefix: join(root, "bin"),
      provider: { source: "cargo-dist" }, source: { owner: "1c-tooling", name: "eska", app_name: "eska", release_type: "github" } }));
  };
  return { root, release, execute, bootstrap: module.exports.bootstrapBundle, counts: () => ({ downloads, disposed }) };
}

test("fresh bootstrap verifies all six installed executables and releases installer resources", { skip: process.platform === "win32" }, async t => {
  const f = await fixture(t);
  const info = await f.bootstrap(f.root, f.release, f.execute, () => {});
  assert.equal(info.path, join(f.root, "bin/eska-project"));
  assert.deepEqual(f.counts(), { downloads: 1, disposed: 1 });
});

test("a successful installer exit cannot hide a missing formatter", { skip: process.platform === "win32" }, async t => {
  const f = await fixture(t);
  await assert.rejects(f.bootstrap(f.root, f.release, async command => {
    await f.execute(command); await rm(join(f.root, "bin/eska-fmt"));
  }, () => {}));
  assert.deepEqual(f.counts(), { downloads: 1, disposed: 1 });
});

test("a partial or component-managed installation is never overwritten by bootstrap", async t => {
  const f = await fixture(t), path = join(f.root, "components/eska-project.json");
  await mkdir(join(f.root, "components"), { recursive: true }); await writeFile(path, "user-owned receipt");
  await assert.rejects(f.bootstrap(f.root, f.release, async () => assert.fail("installer started over existing files"), () => {}), { code: "unmanaged" });
  assert.equal(await readFile(path, "utf8"), "user-owned receipt");
  assert.deepEqual(f.counts(), { downloads: 0, disposed: 0 });
});
