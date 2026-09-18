import { spawn } from "node:child_process";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { resolve, join, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import { createTreeProject } from "./fixture.mjs";

const repository = fileURLToPath(new URL("../", import.meta.url));
const binary = process.env.ESKA_TEST_BINARY;
if (!binary || !isAbsolute(binary)) throw new Error("Set ESKA_TEST_BINARY to an absolute path to an IDE-enabled backend.");
const playground = process.env.ESKA_TEST_ROOT ?? resolve(repository, "../eska-playground");
if (!isAbsolute(playground)) throw new Error("ESKA_TEST_ROOT must be absolute.");
const root = await mkdtemp(join(playground, "explorer-host-"));
try {
  const fixture = await createTreeProject(join(root, "project"));
  const child = spawn(process.env.VSCODE_EXECUTABLE ?? "code", ["--verbose", "--wait",
    `--extensionDevelopmentPath=${repository}`, `--extensionTestsPath=${join(repository, "test/extension-host.cjs")}`,
    `--user-data-dir=${join(root, "profile")}`, `--extensions-dir=${join(root, "extensions")}`,
    "--disable-workspace-trust", "--disable-extensions", "--disable-gpu", "--new-window", fixture.root],
  { env: { ...process.env, ESKA_HOST_FIXTURE: JSON.stringify(fixture) }, stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  /** Retain bounded diagnostic output; host startup can be verbose. */
  const capture = (data) => { output = (output + data.toString()).slice(-32000); };
  child.stdout.on("data", capture);
  child.stderr.on("data", capture);
  const code = await new Promise((resolve, reject) => { child.once("error", reject); child.once("close", resolve); });
  if (code !== 0) throw new Error(`Extension host exited ${code}\n${output}`);
  try { console.log(await readFile(join(fixture.root, "host-result.json"), "utf8")); }
  catch { throw new Error(`Extension host did not report success\n${output}`); }
} finally { await rm(root, { recursive: true, force: true }); }
