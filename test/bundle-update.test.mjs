import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink, access } from "node:fs/promises";
import { join, resolve } from "node:path";
import { inspectBundle, installBundle } from "../out/tooling/bundle.js";
import { runProbe } from "../out/installation.js";

/** Model the native updater in an owned prefix; every subprocess and receipt stays in the playground. */
async function fixture(t) {
  const root = await mkdtemp(join(process.env.ESKA_TEST_ROOT ?? resolve("../eska-playground"), "explorer-bundle-"));
  const prior = { AXOUPDATER_CONFIG_PATH: process.env.AXOUPDATER_CONFIG_PATH, AXOUPDATER_CONFIG_WORKING_DIR: process.env.AXOUPDATER_CONFIG_WORKING_DIR };
  process.env.AXOUPDATER_CONFIG_PATH = root; delete process.env.AXOUPDATER_CONFIG_WORKING_DIR;
  t.after(async () => {
    for (const [key, value] of Object.entries(prior)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    await rm(root, { recursive: true, force: true });
  });
  const bin = join(root, "bin"); await mkdir(bin);
  const cli = join(bin, "eska"), project = join(bin, "eska-project"), receiptFile = join(root, "eska-receipt.json");
  const receipt = { binaries: ["eska", "eska-project", "eska-check", "eska-build", "eska-vcs"], binary_aliases: {}, cdylibs: [], cstaticlibs: [],
    install_layout: "flat", install_prefix: bin, modify_path: true, provider: { source: "cargo-dist", version: "0.32.0" },
    source: { app_name: "eska", name: "eska", owner: "1c-tooling", release_type: "github" }, version: "0.15.2" };
  await writeFile(receiptFile, JSON.stringify(receipt));
  const config = { version: "0.15.2", available: "0.16.0" }, configFile = join(root, "fixture.json");
  const save = () => writeFile(configFile, JSON.stringify(config)); await save();
  const script = `#!${process.execPath}
const fs = require('node:fs'), path = require('node:path');
const file = path.join(__dirname, '..', 'fixture.json'), config = JSON.parse(fs.readFileSync(file, 'utf8'));
const args = process.argv.slice(2), name = path.basename(__filename);
if (args[0] === '--version') { console.log(name + ' ' + (name === 'eska-project' ? config.projectVersion ?? config.version : config.version)); }
else if (name === 'eska' && args.includes('--check')) console.log(JSON.stringify({ schemaVersion: 1, status: config.version === config.available ? 'up-to-date' : 'update-available',
  installedVersion: config.version, availableVersion: config.available, executable: { value: __filename, encoding: 'utf-8' }, method: 'installer', ...config.check }));
else if (name === 'eska' && args[0] === 'update') { config.version = args[2]; fs.writeFileSync(file, JSON.stringify(config)); }
else if (name === 'eska-project' && args[0] === 'serve') {
  let input = Buffer.alloc(0);
  process.stdin.on('data', chunk => {
    input = Buffer.concat([input, chunk]);
    for (;;) {
      const end = input.indexOf('\\r\\n\\r\\n'); if (end < 0) return;
      const length = Number(input.subarray(0, end).toString().split(':')[1]); if (input.length < end + 4 + length) return;
      const request = JSON.parse(input.subarray(end + 4, end + 4 + length)); input = input.subarray(end + 4 + length);
      if (request.method === 'exit') process.exit(0);
      const result = request.method === 'initialize' ? { apiVersion: { major: 1, minor: 30 }, server: { name: 'eska-project', version: config.projectVersion ?? config.version },
        capabilities: { analyzerConfiguration: true, designerXml: true, readOnly: false, propertyEditing: true, metadataRename: true, linkedPropertyEdits: true,
          unsignedIntegerProperties: true, multiContext: false, search: true, clientFileEvents: true }, limits: { maxHeaderBytes: 8192, maxRequestBytes: 1048576, maxResponseBytes: 67108864 } } : null;
      const body = JSON.stringify({ jsonrpc: '2.0', id: request.id, result }); process.stdout.write('Content-Length: ' + Buffer.byteLength(body) + '\\r\\n\\r\\n' + body);
    }
  });
  process.stdin.on('end', () => process.exit(0));
} else process.exit(7);
`;
  for (const name of receipt.binaries) await writeFile(join(bin, name), script, { mode: 0o755 });
  return { root, cli, project, receipt, receiptFile, config, save };
}

test("cargo-dist project uses the adjacent native updater and verifies the installed Metadata API", { skip: process.platform === "win32" }, async t => {
  const f = await fixture(t), update = await inspectBundle(f.root);
  assert.equal(update.version, "0.15.2"); assert.equal(update.available, "0.16.0"); assert.equal(update.cli, f.cli);
  const info = await installBundle(f.root, update, async (cli, args) => {
    assert.equal(cli, f.cli); assert.deepEqual(args, ["update", "--target-version", "0.16.0", "--format", "json"]);
    await runProbe(cli, args, f.root, 10000, 65536);
  }, () => {});
  assert.equal(info.version, "0.16.0"); assert.equal(info.path, f.project);
  await assert.rejects(access(join(f.root, "components/eska-project.json")), { code: "ENOENT" });
  await assert.rejects(access(join(f.root, ".eska-components.claim")), { code: "ENOENT" });
  assert.equal((await inspectBundle(f.root)).version, "0.16.0");
});

for (const scenario of ["foreign", "prefix", "missing-owner", "mixed", "pending", "symlink", "cargo", "wrong-cli", "wrong-version", "inconsistent-status"]) {
  test(`bundle detection rejects unsupported or conflicting ownership: ${scenario}`, { skip: process.platform === "win32" }, async t => {
    const f = await fixture(t);
    if (scenario === "foreign") f.receipt.source.owner = "foreign";
    if (scenario === "prefix") f.receipt.install_prefix = join(f.root, "elsewhere");
    if (scenario === "missing-owner") f.receipt.binaries = ["eska"];
    await writeFile(f.receiptFile, JSON.stringify(f.receipt));
    if (scenario === "mixed") { await mkdir(join(f.root, "components")); await writeFile(join(f.root, "components/eska-vcs.json"), "{}"); }
    if (scenario === "pending") { await mkdir(join(f.root, ".eska-component-test")); await writeFile(join(f.root, ".eska-component-test/journal.json"), "{}"); }
    if (scenario === "symlink") { await rm(f.project); await symlink(f.cli, f.project); }
    if (scenario === "cargo") f.config.check = { method: "cargo" };
    if (scenario === "wrong-cli") f.config.check = { executable: { value: join(f.root, "other/eska"), encoding: "utf-8" } };
    if (scenario === "wrong-version") f.config.check = { installedVersion: "0.14.0" };
    if (scenario === "inconsistent-status") f.config.check = { status: "up-to-date" };
    await f.save(); await assert.rejects(inspectBundle(f.root));
  });
}

test("approval cannot overwrite a subsequently modified binary and a failed installer releases its claim", { skip: process.platform === "win32" }, async t => {
  const f = await fixture(t), update = await inspectBundle(f.root), original = await readFile(f.project);
  await writeFile(f.project, "user replacement");
  await assert.rejects(installBundle(f.root, update, async () => assert.fail("modified binary updated"), () => {}), { code: "modified" });
  await writeFile(f.project, original);
  await assert.rejects(installBundle(f.root, update, async () => { throw new Error("installer failed"); }, () => {}), /installer failed/);
  await assert.rejects(access(join(f.root, ".eska-components.claim")), { code: "ENOENT" });
  assert.equal((await inspectBundle(f.root)).version, "0.15.2");
});

test("a successful task cannot claim an unchanged project was updated", { skip: process.platform === "win32" }, async t => {
  const f = await fixture(t), update = await inspectBundle(f.root);
  await assert.rejects(installBundle(f.root, update, async () => {}, () => {}), { code: "probe", detail: "bundle-version" });
});
