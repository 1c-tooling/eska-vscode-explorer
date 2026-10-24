import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { mkdtemp, rm, readFile, writeFile, cp, mkdir, symlink } from "node:fs/promises";
import { resolve, join, isAbsolute, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { createTreeProject } from "./fixture.mjs";

const repository = fileURLToPath(new URL("../", import.meta.url));
const suite = resolve(repository, process.argv[2] ?? "test/extension-host.cjs");
const binary = process.env.ESKA_TEST_BINARY;
if (!binary || !isAbsolute(binary)) throw new Error("Set ESKA_TEST_BINARY to an absolute path to an IDE-enabled backend.");
const globalBinary = process.env.ESKA_HOST_GLOBAL_BINARY ?? binary;
const backend = process.env.ESKA_TEST_BACKEND ?? "project";
const locale = process.env.ESKA_HOST_LOCALE;
if (locale && !["ru", "en"].includes(locale)) throw new Error("ESKA_HOST_LOCALE must be ru or en.");
if (!["project", "legacy"].includes(backend)) throw new Error("ESKA_TEST_BACKEND must be project or legacy.");
if (!isAbsolute(globalBinary)) throw new Error("ESKA_HOST_GLOBAL_BINARY must be absolute.");
const playground = process.env.ESKA_TEST_ROOT ?? resolve(repository, "../eska-playground");
if (!isAbsolute(playground)) throw new Error("ESKA_TEST_ROOT must be absolute.");
const root = await mkdtemp(join(playground, "explorer-host-"));
try {
  const fixture = await createTreeProject(join(root, "project"), process.env.ESKA_HOST_PROJECT_TYPE ?? "configuration");
  if (["query-tabs-host.cjs", "query-session-host.cjs", "query-bsl-host.cjs", "query-bsl-restore-host.cjs", "query-bsl-windows-host.cjs"].includes(basename(suite))) fixture.query = await (await import("./query-fixture.mjs")).createQuerySource(fixture);
  if (["query-bsl-host.cjs", "query-bsl-restore-host.cjs", "query-bsl-windows-host.cjs"].includes(basename(suite))) {
    await writeFile(fixture.module, '\ufeff// owner 😀\r\nQ = "SELECT 1\r\n|AS Value";\r\nOther = 42;\r\nSecond = "SELECT 9";\r\nComputed = "SELECT " + "1";\r\n');
  }
  // These scenarios exercise language lifecycle, not concurrent mutation of XML during workspace/open.
  if (["language-host.cjs", "language-cancellation-host.cjs"].includes(basename(suite))) {
    fixture.languageSource = await (await import("./language-fixture.mjs")).createLanguageSource(fixture);
  }
  // Reload tests need a stable root descriptor before workspaceContains can activate the extension.
  if (process.env.ESKA_HOST_CONFLICT_RELOAD) await (await import("./language-fixture.mjs")).createLanguageSource(fixture);
  if (process.env.ESKA_HOST_LANGUAGE_PARITY) await (await import("./language-fixture.mjs")).createLanguageParitySource(fixture);
  else if (process.env.ESKA_HOST_LANGUAGE_MUTATION) await (await import("./language-fixture.mjs")).createLanguageMutationSource(fixture);
  else if (process.env.ESKA_HOST_LANGUAGE_EDITS) await (await import("./language-fixture.mjs")).createLanguageSupportSource(fixture);
  if (process.env.ESKA_HOST_LANGUAGE_REFRESH) await (await import("./language-fixture.mjs")).createLanguageSource(fixture);
  const bin = join(root, "bin");
  await mkdir(bin);
  const component = backend === "legacy" ? "eska" : "eska-project";
  const executableName = process.platform === "win32" ? `${component}.exe` : component;
  if (process.platform === "win32") await cp(globalBinary, join(bin, executableName));
  else await symlink(globalBinary, join(bin, executableName));
  await mkdir(join(fixture.root, ".vscode"), { recursive: true });
  await writeFile(join(fixture.root, ".vscode/settings.json"), JSON.stringify({ "eska.explorer.checkForUpdates": false, "eska.explorer.checkForAnalyzerUpdates": false, "eska.explorer.languageFeatures": process.env.ESKA_TEST_LANGUAGE === "1", "eska.explorer.analyzerExecutable": process.env.ESKA_TEST_ANALYZER_BINARY ?? join(root, "missing-analyzer"), "eska.explorer.backend": backend,
    ...(process.env.ESKA_HOST_GLOBAL_BINARY || fixture.query ? { "eska.explorer.executable": binary } : {}),
    ...(process.env.ESKA_HOST_SUPPORT_DISABLED ? { "eska.explorer.supportPolicy": false } : {}) }));
  const executable = process.env.VSCODE_EXECUTABLE ?? "code";
  let extensionPath = repository;
  if (process.env.ESKA_HOST_LANGUAGE_PACK_VSIX) {
    const languagePack = process.env.ESKA_HOST_LANGUAGE_PACK_VSIX;
    if (!isAbsolute(languagePack)) throw new Error("ESKA_HOST_LANGUAGE_PACK_VSIX must be absolute.");
    const { promisify } = await import("node:util");
    const { execFile } = await import("node:child_process");
    await promisify(execFile)(executable, [`--user-data-dir=${join(root, "profile")}`, `--extensions-dir=${join(root, "extensions")}`,
      "--install-extension", languagePack, "--force"], { timeout: 60000 });
  }
  const conflictFixture = process.env.ESKA_HOST_CONFLICT_FIXTURE ? await (await import("./conflict-fixture.mjs")).createConflictFixture(root) : undefined;
  if (conflictFixture && process.env.ESKA_HOST_CONFLICT_FIXTURE === "initial") {
    await cp(conflictFixture.folder, join(root, "extensions", "elishevkirill.bsl-analyzer-lsp-0.0.1"), { recursive: true });
  }
  if (process.env.ESKA_BSL_EXTENSION) {
    if (!isAbsolute(process.env.ESKA_BSL_EXTENSION) || !isAbsolute(process.env.ESKA_BSL_BINARY ?? "")) {
      throw new Error("ESKA_BSL_EXTENSION and ESKA_BSL_BINARY must be absolute.");
    }
    const analyzer = JSON.parse(await readFile(join(process.env.ESKA_BSL_EXTENSION, "package.json"), "utf8"));
    await cp(process.env.ESKA_BSL_EXTENSION, join(root, "extensions", `${analyzer.publisher}.${analyzer.name}-${analyzer.version}`), { recursive: true });
    await mkdir(join(fixture.root, ".vscode"), { recursive: true });
    await writeFile(join(fixture.root, ".vscode", "settings.json"), JSON.stringify({
      "eska.explorer.checkForUpdates": false, "eska.explorer.checkForAnalyzerUpdates": false, "eska.explorer.languageFeatures": process.env.ESKA_TEST_LANGUAGE === "1", "eska.explorer.analyzerExecutable": process.env.ESKA_TEST_ANALYZER_BINARY ?? join(root, "missing-analyzer"), "eska.explorer.backend": backend,
      "bsl-analyzer-lsp.server.path": process.env.ESKA_BSL_BINARY,
      "[bsl]": { "editor.defaultFormatter": `${analyzer.publisher}.${analyzer.name}` },
      ...(process.env.ESKA_HOST_SUPPORT_DISABLED ? { "eska.explorer.supportPolicy": false } : {})
    }));
    if (!process.env.ESKA_BSL_DISABLED) await writeFile(join(fixture.root, "bsl-analyzer.toml"), '[source]\nroot = "src"\n');
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
  let secondFixture;
  if (process.env.ESKA_HOST_MULTI_ROOT) {
    secondFixture = await createTreeProject(join(root, "second"));
    workspace = join(root, "support.code-workspace");
    await writeFile(workspace, JSON.stringify({ folders: [{ path: fixture.root }, { path: secondFixture.root }], settings: { "eska.explorer.checkForUpdates": false, "eska.explorer.checkForAnalyzerUpdates": false, "eska.explorer.languageFeatures": process.env.ESKA_TEST_LANGUAGE === "1", "eska.explorer.analyzerExecutable": process.env.ESKA_TEST_ANALYZER_BINARY ?? join(root, "missing-analyzer"), "eska.explorer.backend": backend } }));
  }
  if (process.env.ESKA_PERF_PROJECT) {
    if (!isAbsolute(process.env.ESKA_PERF_PROJECT)) throw new Error("ESKA_PERF_PROJECT must be absolute.");
    workspace = join(root, "performance.code-workspace");
    await writeFile(workspace, JSON.stringify({ folders: [{ path: process.env.ESKA_PERF_PROJECT }], settings: { "eska.explorer.checkForUpdates": false, "eska.explorer.checkForAnalyzerUpdates": false, "eska.explorer.languageFeatures": process.env.ESKA_TEST_LANGUAGE === "1", "eska.explorer.analyzerExecutable": process.env.ESKA_TEST_ANALYZER_BINARY ?? join(root, "missing-analyzer"), "eska.explorer.backend": backend,
      ...(process.env.ESKA_HOST_SUPPORT_DISABLED ? { "eska.explorer.supportPolicy": false } : {}) } }));
  }
  // A second process reuses the same profile and workspace to test restored editors.
  const hostArguments = [`--extensionTestsPath=${suite}`];
  let languageWarmup;
  if (process.env.ESKA_HOST_LANGUAGE_PACK_VSIX) {
    // A fresh profile registers installed language packs during its first normal startup.
    // Passing --locale before that registration still resolves to English.
    languageWarmup = join(root, "language-pack-registration");
    await mkdir(languageWarmup);
    await writeFile(join(languageWarmup, "package.json"), JSON.stringify({ name: "language-pack-registration", publisher: "eska-test",
      version: "0.0.1", engines: { vscode: "^1.109.0" }, main: "./extension.cjs", activationEvents: ["onStartupFinished"] }));
    await writeFile(join(languageWarmup, "extension.cjs"), `const vscode = require('vscode');
exports.activate = async function () {
  await require('node:fs/promises').writeFile(${JSON.stringify(join(fixture.root, "host-result.json"))},
    JSON.stringify({ passed: true, suite: 'language-pack-registration', locale: vscode.env.language }));
  await vscode.commands.executeCommand('workbench.action.closeWindow');
};\n`);
  }
  let installedStartupProbe = false;
  if (process.env.ESKA_HOST_RESTART || process.env.ESKA_HOST_NORMAL) {
    // VS Code deliberately skips editor restoration in extension-test mode. Run the
    // same assertions from a disposable startup extension in a normal development host.
    const probe = join(root, "restore-probe");
    await mkdir(probe);
    await writeFile(join(probe, "package.json"), JSON.stringify({ name: "restore-probe", publisher: "eska-test",
      version: "0.0.1", engines: { vscode: "^1.109.0" }, main: "./extension.cjs", activationEvents: ["onStartupFinished"] }));
    await writeFile(join(probe, "extension.cjs"), `const vscode = require('vscode');
exports.activate = async function () {
  if (process.env.ESKA_HOST_RUN === '-1') return;
  try { await require(${JSON.stringify(suite)}).run(); }
  catch (error) {
    await require('node:fs/promises').writeFile(${JSON.stringify(join(fixture.root, "host-result.json"))},
      JSON.stringify({ passed: false, error: String(error.stack ?? error) }));
  }
  await vscode.commands.executeCommand('workbench.action.closeWindow');
};\n`);
    if (process.env.ESKA_TEST_VSIX) {
      // Development hosts suppress native hot-exit backups; a real installed startup probe preserves the normal lifecycle.
      const probeVsix = join(root, "restore-probe.vsix");
      const { promisify } = await import("node:util");
      const { execFile } = await import("node:child_process");
      await writeFile(join(probe, "README.md"), "# Private ESKA acceptance probe\n");
      await promisify(execFile)(process.execPath, [join(repository, "node_modules/@vscode/vsce/vsce"), "package", "--no-dependencies",
        "--allow-missing-repository", "--skip-license", "--out", probeVsix], { cwd: probe });
      await promisify(execFile)(executable, [`--user-data-dir=${join(root, "profile")}`, `--extensions-dir=${join(root, "extensions")}`,
        "--install-extension", probeVsix, "--force"]);
      hostArguments.splice(0, 1);
      installedStartupProbe = true;
    } else hostArguments.splice(0, 1, `--extensionDevelopmentPath=${probe}`);
  }
  const runs = process.env.ESKA_HOST_CONFLICT_RELOAD ? 3 : process.env.ESKA_HOST_RESTART || process.env.ESKA_HOST_QUERY_RESTART ? 2 : 1;
  for (let run = languageWarmup ? -1 : 0; run < runs; run++) {
    await rm(join(fixture.root, "host-result.json"), { force: true });
    const child = spawn(executable, ["--verbose", "--wait", ...(locale ? [`--locale=${locale}`] : []), ...(process.env.ESKA_HOST_DEBUG_PORT ? [`--remote-debugging-port=${process.env.ESKA_HOST_DEBUG_PORT}`] : []),
      ...(installedStartupProbe && run !== -1 ? [] : [`--extensionDevelopmentPath=${extensionPath}`]), ...(run === -1 ? [`--extensionDevelopmentPath=${languageWarmup}`] : hostArguments),
      `--user-data-dir=${join(root, "profile")}`, `--extensions-dir=${join(root, "extensions")}`,
      "--disable-workspace-trust", ...(process.env.ESKA_BSL_EXTENSION || process.env.ESKA_HOST_ENABLE_EXTENSIONS || languageWarmup || installedStartupProbe ? [] : ["--disable-extensions"]),
      ...(process.env.ESKA_BSL_DISABLED || process.env.ESKA_HOST_CONFLICT_RELOAD && run === 1 ? ["--disable-extension=elishevkirill.bsl-analyzer-lsp"] : []), "--disable-gpu", "--new-window", workspace],
    { env: { ...process.env, PATH: bin + (process.platform === "win32" ? ";" : ":") + (process.env.PATH ?? ""), ESKA_HOST_RUN: String(run),
      ...(conflictFixture ? { ESKA_HOST_CONFLICT_VSIX: conflictFixture.vsix } : {}),
      ESKA_HOST_FIXTURE: JSON.stringify(fixture), ESKA_HOST_SECOND_FIXTURE: JSON.stringify(secondFixture) }, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    const fullLog = process.env.ESKA_HOST_FULL_LOG ? createWriteStream(process.env.ESKA_HOST_FULL_LOG) : undefined;
    /** Retain bounded diagnostic output; host startup can be verbose. */
    const capture = (data) => { fullLog?.write(data); output = (output + data.toString()).slice(-32000); };
    child.stdout.on("data", capture);
    child.stderr.on("data", capture);
    const code = await new Promise((resolve, reject) => { child.once("error", reject); child.once("close", resolve); });
    if (fullLog) await new Promise(resolve => fullLog.end(resolve));
    if (process.env.ESKA_HOST_LOG) await writeFile(process.env.ESKA_HOST_LOG, output);
    if (code !== 0) throw new Error(`Extension host exited ${code}\n${output}`);
    try {
      const result = JSON.parse(await readFile(join(fixture.root, "host-result.json"), "utf8"));
      if (result.passed !== true) {
        if (process.env.ESKA_HOST_FULL_LOG) await writeFile(`${process.env.ESKA_HOST_FULL_LOG}.result.json`, JSON.stringify(result, null, 2) + "\n");
        throw new Error(`Acceptance result did not pass: ${result.error ?? "unknown failure"}`);
      }
      for (const pid of result.shutdownPids ?? []) {
        try { process.kill(pid, 0); }
        catch (error) { if (error.code === "ESRCH") continue; throw error; }
        // Only a PID recorded by this fixture is eligible for cleanup after a failed shutdown check.
        process.kill(pid, "SIGKILL");
        throw new Error(`Backend ${pid} survived native host shutdown`);
      }
      console.log(JSON.stringify(result));
    }
    catch (error) { throw new Error(`Extension host did not report success: ${error.message}\n${output}`); }
  }
} finally { await rm(root, { recursive: true, force: true }); }
