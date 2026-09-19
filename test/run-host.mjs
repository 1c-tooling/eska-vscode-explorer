import { spawn } from "node:child_process";
import { mkdtemp, rm, readFile, writeFile, cp, mkdir, symlink } from "node:fs/promises";
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
  const bin = join(root, "bin");
  await mkdir(bin);
  const executableName = process.platform === "win32" ? "eska.exe" : "eska";
  if (process.platform === "win32") await cp(binary, join(bin, executableName));
  else await symlink(binary, join(bin, executableName));
  await mkdir(join(fixture.root, ".vscode"), { recursive: true });
  await writeFile(join(fixture.root, ".vscode/settings.json"), JSON.stringify({ "eska.explorer.checkForUpdates": false }));
  const executable = process.env.VSCODE_EXECUTABLE ?? "code";
  let extensionPath = repository;
  if (process.env.ESKA_BSL_EXTENSION) {
    if (!isAbsolute(process.env.ESKA_BSL_EXTENSION) || !isAbsolute(process.env.ESKA_BSL_BINARY ?? "")) {
      throw new Error("ESKA_BSL_EXTENSION and ESKA_BSL_BINARY must be absolute.");
    }
    const analyzer = JSON.parse(await readFile(join(process.env.ESKA_BSL_EXTENSION, "package.json"), "utf8"));
    await cp(process.env.ESKA_BSL_EXTENSION, join(root, "extensions", `${analyzer.publisher}.${analyzer.name}-${analyzer.version}`), { recursive: true });
    await mkdir(join(fixture.root, ".vscode"), { recursive: true });
    await writeFile(join(fixture.root, ".vscode", "settings.json"), JSON.stringify({
      "eska.explorer.checkForUpdates": false,
      "bsl-analyzer-lsp.server.path": process.env.ESKA_BSL_BINARY,
      "[bsl]": { "editor.defaultFormatter": `${analyzer.publisher}.${analyzer.name}` }
    }));
    await writeFile(join(fixture.root, "bsl-analyzer.toml"), '[source]\nroot = "src"\n');
  }
  if (process.env.ESKA_TEST_VSIX) {
    if (!isAbsolute(process.env.ESKA_TEST_VSIX)) throw new Error("ESKA_TEST_VSIX must be absolute.");
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const run = promisify(execFile);
    const directories = [`--user-data-dir=${join(root, "profile")}`, `--extensions-dir=${join(root, "extensions")}`];
    await run(executable, [...directories, "--install-extension", process.env.ESKA_TEST_VSIX], { timeout: 60000 });
    const { stdout } = await run(executable, [...directories, "--list-extensions", "--show-versions"], { timeout: 30000 });
    const installed = stdout.split(/\r?\n/).find(line => line.startsWith("1c-tooling.eska-explorer@"));
    if (!installed) throw new Error(`VSIX was not installed: ${stdout}`);
    extensionPath = join(root, "extensions", installed.replace("@", "-"));
    // Test mode exposes the provider only for acceptance. All runtime files come from the installed VSIX.
  }
  let workspace = fixture.root;
  if (process.env.ESKA_PERF_PROJECT) {
    if (!isAbsolute(process.env.ESKA_PERF_PROJECT)) throw new Error("ESKA_PERF_PROJECT must be absolute.");
    workspace = join(root, "performance.code-workspace");
    await writeFile(workspace, JSON.stringify({ folders: [{ path: process.env.ESKA_PERF_PROJECT }], settings: { "eska.explorer.checkForUpdates": false } }));
  }
  const child = spawn(executable, ["--verbose", "--wait",
    `--extensionDevelopmentPath=${extensionPath}`, `--extensionTestsPath=${resolve(repository, process.argv[2] ?? "test/extension-host.cjs")}`,
    `--user-data-dir=${join(root, "profile")}`, `--extensions-dir=${join(root, "extensions")}`,
    "--disable-workspace-trust", ...(process.env.ESKA_BSL_EXTENSION ? [] : ["--disable-extensions"]), "--disable-gpu", "--new-window", workspace],
  { env: { ...process.env, PATH: bin + (process.platform === "win32" ? ";" : ":") + (process.env.PATH ?? ""), ESKA_HOST_FIXTURE: JSON.stringify(fixture) }, stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  /** Retain bounded diagnostic output; host startup can be verbose. */
  const capture = (data) => { output = (output + data.toString()).slice(-32000); };
  child.stdout.on("data", capture);
  child.stderr.on("data", capture);
  const code = await new Promise((resolve, reject) => { child.once("error", reject); child.once("close", resolve); });
  if (code !== 0) throw new Error(`Extension host exited ${code}\n${output}`);
  try {
    const result = JSON.parse(await readFile(join(fixture.root, "host-result.json"), "utf8"));
    if (result.passed !== true) throw new Error("Acceptance result did not pass");
    console.log(JSON.stringify(result));
  }
  catch { throw new Error(`Extension host did not report success\n${output}`); }
} finally { await rm(root, { recursive: true, force: true }); }
