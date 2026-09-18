import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm, readFile } from "node:fs/promises";
import { resolve, join, isAbsolute, basename } from "node:path";
import { Connection } from "../out/connection.js";
import { BackendProcess } from "../out/process.js";

const executable = process.env.ESKA_TEST_BINARY;

/** Generate minimal Designer XML solely in this test's owned playground directory. */
async function project(root, type) {
  await mkdir(join(root, "src"), { recursive: true });
  const kind = { configuration: "Configuration", extension: "Configuration", processing: "ExternalDataProcessor", report: "ExternalReport" }[type];
  const file = type === "configuration" || type === "extension" ? "Configuration.xml" : "Тест.xml";
  const xml = `<?xml version="1.0" encoding="UTF-8"?><MetaDataObject xmlns="http://v8.1c.ru/8.3/MDClasses" version="2.20"><${kind} uuid="11111111-1111-1111-1111-111111111111"><Properties><Name>Тест</Name>${type === "extension" ? "<ConfigurationExtensionPurpose>Patch</ConfigurationExtensionPurpose>" : ""}</Properties><ChildObjects/></${kind}></MetaDataObject>`;
  await writeFile(join(root, "src", file), xml);
  await writeFile(join(root, "eska.toml"), `[project]\nname='${basename(root)}'\ntype='${type}'\n`);
  return { path: join(root, "src", file), xml };
}

test("real eska: four project types, two workspace members, errors and restarts", { skip: !executable }, async (t) => {
  const playground = process.env.ESKA_TEST_ROOT ?? resolve("../eska-playground");
  assert.ok(isAbsolute(playground), "ESKA_TEST_ROOT must be absolute");
  assert.ok(isAbsolute(executable), "ESKA_TEST_BINARY must be absolute");
  const root = await mkdtemp(join(playground, "explorer-integration-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const pids = [];
  const connection = new Connection("0.0.0", () => {}, () => {}, (options) => {
    const child = new BackendProcess(options);
    pids.push(child.pid);
    return child;
  });
  t.after(() => connection.dispose());
  /** Open through the same controller used by the extension adapter. */
  async function open(path, locale = "ru-RU") {
    await connection.connect({ executable, path, name: "integration", locale });
    return connection.state;
  }
  for (const type of ["configuration", "extension", "processing", "report"]) {
    const path = join(root, type);
    const source = await project(path, type);
    const state = await open(path);
    assert.equal(state.kind, "ready", JSON.stringify(state));
    assert.equal(state.session.projects[0].type, type);
    assert.equal(await readFile(source.path, "utf8"), source.xml);
  }
  const workspace = join(root, "workspace");
  await project(join(workspace, "first"), "processing");
  await project(join(workspace, "second"), "report");
  await writeFile(join(workspace, "eska.toml"), "[workspace]\nmembers=['first','second']\n");
  const state = await open(workspace, "en-US");
  assert.equal(state.kind, "ready", JSON.stringify(state));
  assert.deepEqual(state.session.projects.map((p) => p.scope.name).sort(), ["first", "second"]);
  assert.equal(new Set(state.session.projects.map((p) => p.projectId)).size, 2);

  const empty = join(root, "empty");
  await mkdir(empty);
  assert.equal((await open(empty)).error.code, "manifestMissing");
  await writeFile(join(empty, "eska.toml"), "[project]\ntype='unknown'\n");
  assert.equal((await open(empty)).error.code, "manifestInvalid");
  await writeFile(join(empty, "eska.toml"), "this is not valid TOML");
  assert.equal((await open(empty)).error.code, "manifestInvalid");
  await project(empty, "configuration");
  await writeFile(join(empty, "eska.toml"), "[project]\ntype='report'\n");
  assert.equal((await open(empty)).error.code, "rootInvalid");
  assert.equal((await open(workspace)).kind, "ready");
  await connection.dispose();
  for (const pid of pids) assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
});
