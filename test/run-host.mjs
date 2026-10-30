import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
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
// VS Code's Uri.fsPath lowercases drive letters; keep native fixture expectations in that form.
const root = (await mkdtemp(join(playground, "explorer-host-"))).replace(/^[A-Z]:/, drive => drive.toLowerCase());
try {
  await mkdir(join(root, "profile", "User"), { recursive: true });
  await writeFile(join(root, "profile", "User", "settings.json"), JSON.stringify({
    "workbench.startupEditor": "none", "onboarding.enabled": false,
  }));
  const fixture = await createTreeProject(join(root, "project"), basename(suite) === "language-reference-host.cjs" ? "processing" : process.env.ESKA_HOST_PROJECT_TYPE ?? "configuration");
  if (["query-layout-host.cjs", "query-compact-performance-host.cjs"].includes(basename(suite))) {
    fixture.query = await (await import("./query-fixture.mjs")).createQuerySource(fixture);
    const fields = Array.from({ length: 48 }, (_, index) => `${index} AS КолонкаРезультата${index}WithLongEnglishName`).join(',\r\n|');
    await writeFile(fixture.module, `\ufeffПроцедура Test()\r\nQ = "SELECT ${fields}\r\n|FROM (SELECT 1 AS NestedValue) AS Child";\r\nКонецПроцедуры\r\n`);
  }
  if (basename(suite) === "formatting-host.cjs") {
    if (process.env.ESKA_TEST_LANGUAGE === "1") fixture.languageSource = await (await import("./language-fixture.mjs")).createLanguageSource(fixture);
    fixture.query = await (await import("./query-fixture.mjs")).createQuerySource(fixture);
    await writeFile(fixture.module, '\ufeff// owner 😀\r\nПроцедура Test()\r\nЗначение=1;\r\nТекст="выбрать 1 как А,2 как Б";\r\nКонецПроцедуры\r\n');
  }
  if (basename(suite) === "formatting-readonly-host.cjs") {
    await mkdir(join(fixture.source, "Ext"), { recursive: true });
    await writeFile(join(fixture.source, "Ext", "ParentConfigurations.bin"), "{6,0,0,0,0,0}");
    await writeFile(fixture.module, "Procedure Test()\nValue=1;\nOther=2;\nEndProcedure\n");
  }
  if (basename(suite) === "language-reference-host.cjs") {
    fixture.reference = await (await import("./language-fixture.mjs")).createReferenceSource(fixture, root);
  }
  if (["query-advanced-host.cjs", "query-package-host.cjs", "query-having-host.cjs", "query-total-sections-host.cjs", "query-dcs-host.cjs"].includes(basename(suite))) {
    await (await import("./query-advanced-fixture.mjs")).addQueryRegister(fixture);
    fixture.query = await (await import("./query-fixture.mjs")).createQuerySource(fixture);
    await writeFile(fixture.module, '\ufeff// owner 😀\r\nQ = "SELECT 1\r\n|AS Value";\r\nOther = 42;\r\n');
  }
  if (basename(suite) === "query-dcs-host.cjs") {
    await writeFile(fixture.module, '\ufeff// owner 😀\r\nQ = "SELECT T.Ref AS Value FROM Catalog.Товары AS T";\r\nOther = 42;\r\n');
  }
  if (["query-tabs-host.cjs", "query-session-host.cjs", "query-bsl-host.cjs", "query-bsl-restore-host.cjs", "query-bsl-windows-host.cjs", "query-modal-host.cjs", "query-modal-normal-host.cjs", "query-modal-restore-host.cjs", "query-builder-host.cjs"].includes(basename(suite))) fixture.query = await (await import("./query-fixture.mjs")).createQuerySource(fixture);
  if (["query-bsl-host.cjs", "query-bsl-restore-host.cjs", "query-bsl-windows-host.cjs", "query-modal-host.cjs", "query-modal-normal-host.cjs", "query-modal-restore-host.cjs", "query-builder-host.cjs"].includes(basename(suite))) {
    await writeFile(fixture.module, '\ufeff// owner 😀\r\nQ = "SELECT 1\r\n|AS Value";\r\nOther = 42;\r\nSecond = "SELECT 9";\r\nComputed = "SELECT " + "1";\r\n');
  }
  if (basename(suite) === "query-language-context-host.cjs") fixture.applications = await (await import("./query-language-fixture.mjs")).createQueryLanguageContexts(fixture);
  if (basename(suite) === "query-language-host.cjs") fixture.languageSource = await (await import("./query-language-fixture.mjs")).createQueryLanguageSource(fixture);
  if (["query-constructor-host.cjs", "query-items-host.cjs", "query-predicates-host.cjs", "query-union-matrix-host.cjs", "query-package-tree-host.cjs", "query-modifiers-host.cjs", "query-text-host.cjs"].includes(basename(suite))) {
    fixture.query = await (await import("./query-fixture.mjs")).createQuerySource(fixture);
    await writeFile(fixture.module, '\ufeff// owner 😀\r\nПроцедура Test()\r\nQ = "SELECT 1 AS A,\r\n|// field B 😀\r\n|2 AS B";\r\nOther = 42;\r\nКонецПроцедуры\r\n');
    const schema = await readFile(fixture.query.schemaPath, "utf8");
    const querySchema=schema.replace('<query><!--keep--><![CDATA[SELECT 1;\r\n// пакет 😀\r\nSELECT 77]]></query>', '<query>SELECT Lo<!--source 😀-->ng</query>');
    await writeFile(fixture.query.schemaPath,basename(suite)==='query-constructor-host.cjs'?querySchema.replace('<other>before</other>','<other>prior input 😀</other>'):querySchema);

  }
  // These scenarios exercise language lifecycle, not concurrent mutation of XML during workspace/open.
  if (["language-host.cjs", "language-cancellation-host.cjs", "bundle-update-host.cjs"].includes(basename(suite))) {
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
  // Prevent the first-run welcome page from taking focus during native formatting/menu assertions.
  const nativeUiSettings = ["formatting-readonly-host.cjs", "tool-status-host.cjs", "language-host.cjs"].includes(basename(suite)) ? { "workbench.startupEditor": "none" } : {};
  // Configure the binary before activation: a later settings notification deliberately disconnects.
  // The general explorer suite separately exercises discovery through the isolated PATH.
  const explicitBinary = process.env.ESKA_HOST_GLOBAL_BINARY || basename(suite) !== "extension-host.cjs";
  await writeFile(join(fixture.root, ".vscode/settings.json"), JSON.stringify({ ...nativeUiSettings, "eska.explorer.checkForUpdates": false, "eska.explorer.checkForAnalyzerUpdates": false, "eska.explorer.checkForFormatterUpdates": false, ...(process.env.ESKA_TEST_FMT_BINARY ? { "eska.explorer.formatterExecutable": process.env.ESKA_TEST_FMT_BINARY } : {}), "eska.explorer.languageFeatures": process.env.ESKA_TEST_LANGUAGE === "1", "eska.explorer.analyzerExecutable": process.env.ESKA_TEST_ANALYZER_BINARY ?? join(root, "missing-analyzer"), "eska.explorer.backend": backend,
    ...(explicitBinary ? { "eska.explorer.executable": binary } : {}),
    ...(process.env.ESKA_HOST_SUPPORT_DISABLED ? { "eska.explorer.supportPolicy": false } : {}) }));
  const executable = process.env.VSCODE_EXECUTABLE ?? "code";
  // Windows Code.exe launches the workbench; extension installation belongs to its Node CLI.
  const cli = process.env.VSCODE_CLI_JS;
  if (cli && !isAbsolute(cli)) throw new Error("VSCODE_CLI_JS must be absolute.");
  const run = promisify(execFile);
  const runCli = (args, options) => run(executable, cli ? [cli, ...args] : args, {
    ...options, windowsHide: true,
    ...(cli ? { env: { ...process.env, ...options?.env, ELECTRON_RUN_AS_NODE: "1" } } : {}),
  });
  let extensionPath = repository;
  if (process.env.ESKA_HOST_LANGUAGE_PACK_VSIX) {
    const languagePack = process.env.ESKA_HOST_LANGUAGE_PACK_VSIX;
    if (!isAbsolute(languagePack)) throw new Error("ESKA_HOST_LANGUAGE_PACK_VSIX must be absolute.");
    await runCli([`--user-data-dir=${join(root, "profile")}`, `--extensions-dir=${join(root, "extensions")}`,
      "--install-extension", languagePack, "--force"], { timeout: 120000 });
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
      "eska.explorer.checkForUpdates": false, "eska.explorer.checkForAnalyzerUpdates": false, "eska.explorer.checkForFormatterUpdates": false, ...(process.env.ESKA_TEST_FMT_BINARY ? { "eska.explorer.formatterExecutable": process.env.ESKA_TEST_FMT_BINARY } : {}), "eska.explorer.languageFeatures": process.env.ESKA_TEST_LANGUAGE === "1", "eska.explorer.analyzerExecutable": process.env.ESKA_TEST_ANALYZER_BINARY ?? join(root, "missing-analyzer"), "eska.explorer.backend": backend,
      "bsl-analyzer-lsp.server.path": process.env.ESKA_BSL_BINARY,
      "[bsl]": { "editor.defaultFormatter": `${analyzer.publisher}.${analyzer.name}` },
      ...(process.env.ESKA_HOST_SUPPORT_DISABLED ? { "eska.explorer.supportPolicy": false } : {})
    }));
    if (!process.env.ESKA_BSL_DISABLED) await writeFile(join(fixture.root, "bsl-analyzer.toml"), '[source]\nroot = "src"\n');
  }
  if (process.env.ESKA_TEST_VSIX) {
    if (!isAbsolute(process.env.ESKA_TEST_VSIX)) throw new Error("ESKA_TEST_VSIX must be absolute.");
    const directories = [`--user-data-dir=${join(root, "profile")}`, `--extensions-dir=${join(root, "extensions")}`];
    await runCli([...directories, "--install-extension", process.env.ESKA_TEST_VSIX], { timeout: 120000 });
    const { stdout } = await runCli([...directories, "--list-extensions", "--show-versions"], { timeout: 30000 });
    const installed = stdout.split(/\r?\n/).find(line => line.startsWith("1c-tooling.eska-explorer@"));
    if (!installed) throw new Error(`VSIX was not installed: ${stdout}`);
    extensionPath = join(root, "extensions", installed.replace("@", "-"));
    const { createHash } = await import("node:crypto");
    const installedBundle = await readFile(join(extensionPath,"out/extension.js"));
    if (!installedBundle.equals(await readFile(join(repository,"out/extension.js")))) throw new Error("Installed VSIX bundle differs from the packaged checkout.");
    const installedRenderer = await readFile(join(extensionPath,"resources/properties/view.js"));
    if (!installedRenderer.equals(await readFile(join(repository,"resources/properties/view.js")))) throw new Error("Installed VSIX property renderer differs from the checkout.");
    console.log(JSON.stringify({installedVsix:process.env.ESKA_TEST_VSIX,installedBundle:join(extensionPath,"out/extension.js"),bundleSha256:createHash("sha256").update(installedBundle).digest("hex"),
      propertyRendererSha256:createHash("sha256").update(installedRenderer).digest("hex")}));
    // Test mode exposes the provider only for acceptance. All runtime files come from the installed VSIX.
  }
  let workspace = fixture.root;
  let secondFixture;
  if (process.env.ESKA_HOST_MULTI_ROOT) {
    secondFixture = await createTreeProject(join(root, "second"));
    workspace = join(root, "support.code-workspace");
    await writeFile(workspace, JSON.stringify({ folders: [{ path: fixture.root }, { path: secondFixture.root }], settings: { "eska.explorer.checkForUpdates": false, "eska.explorer.checkForAnalyzerUpdates": false, "eska.explorer.checkForFormatterUpdates": false, ...(process.env.ESKA_TEST_FMT_BINARY ? { "eska.explorer.formatterExecutable": process.env.ESKA_TEST_FMT_BINARY } : {}), "eska.explorer.languageFeatures": process.env.ESKA_TEST_LANGUAGE === "1", "eska.explorer.analyzerExecutable": process.env.ESKA_TEST_ANALYZER_BINARY ?? join(root, "missing-analyzer"), "eska.explorer.backend": backend } }));
  }
  if (process.env.ESKA_PERF_PROJECT) {
    if (!isAbsolute(process.env.ESKA_PERF_PROJECT)) throw new Error("ESKA_PERF_PROJECT must be absolute.");
    workspace = join(root, "performance.code-workspace");
    await writeFile(workspace, JSON.stringify({ folders: [{ path: process.env.ESKA_PERF_PROJECT }], settings: { "eska.explorer.checkForUpdates": false, "eska.explorer.checkForAnalyzerUpdates": false, "eska.explorer.checkForFormatterUpdates": false, ...(process.env.ESKA_TEST_FMT_BINARY ? { "eska.explorer.formatterExecutable": process.env.ESKA_TEST_FMT_BINARY } : {}), "eska.explorer.languageFeatures": process.env.ESKA_TEST_LANGUAGE === "1", "eska.explorer.analyzerExecutable": process.env.ESKA_TEST_ANALYZER_BINARY ?? join(root, "missing-analyzer"), "eska.explorer.backend": backend, "eska.explorer.executable": binary,
      ...(process.env.ESKA_HOST_SUPPORT_DISABLED ? { "eska.explorer.supportPolicy": false } : {}) } }));
  }
  // A second process reuses the same profile and workspace to test restored editors.
  // Validate the actual host locale, including normal startup probes, before the suite runs.
  const hostSuite = join(root, "locale-suite.cjs");
  await writeFile(hostSuite, `exports.run = async function () {
    const vscode = require('vscode');
    const assert = require('node:assert/strict');
    const expected = process.env.ESKA_HOST_LOCALE;
    if (expected) assert.equal(vscode.env.language.split('-')[0], expected, 'native host locale');
    await require(${JSON.stringify(suite)}).run();
    const fs = require('node:fs/promises'), file = ${JSON.stringify(join(fixture.root, "host-result.json"))};
    const result = JSON.parse(await fs.readFile(file, 'utf8'));
    await fs.writeFile(file, JSON.stringify({ ...result, locale: vscode.env.language }));
  };\n`);
  const hostArguments = [`--extensionTestsPath=${hostSuite}`];
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
  try { await require(${JSON.stringify(hostSuite)}).run(); }
  catch (error) {
    const fs = require('node:fs/promises'), file = ${JSON.stringify(join(fixture.root, "host-result.json"))};
    let reported;
    try { reported = JSON.parse(await fs.readFile(file, 'utf8')); } catch {}
    // Keep the suite's precise failure evidence, including UI state and completed assertions.
    if (reported?.passed !== false) await fs.writeFile(file, JSON.stringify({ passed: false, error: String(error.stack ?? error) }));
  }
  await vscode.commands.executeCommand('workbench.action.closeWindow');
};\n`);
    if (process.env.ESKA_TEST_VSIX) {
      // Development hosts suppress native hot-exit backups; a real installed startup probe preserves the normal lifecycle.
      const probeVsix = join(root, "restore-probe.vsix");
      await writeFile(join(probe, "README.md"), "# Private ESKA acceptance probe\n");
      await run(process.execPath, [join(repository, "node_modules/@vscode/vsce/vsce"), "package", "--no-dependencies",
        "--allow-missing-repository", "--skip-license", "--out", probeVsix], { cwd: probe });
      await runCli([`--user-data-dir=${join(root, "profile")}`, `--extensions-dir=${join(root, "extensions")}`,
        "--install-extension", probeVsix, "--force"]);
      hostArguments.splice(0, 1);
      installedStartupProbe = true;
    } else hostArguments.splice(0, 1, `--extensionDevelopmentPath=${probe}`);
  }
  let languageAttempts = 0;
  const runs = process.env.ESKA_HOST_CONFLICT_RELOAD ? 3 : process.env.ESKA_HOST_RESTART || process.env.ESKA_HOST_QUERY_RESTART ? 2 : 1;
  for (let run = languageWarmup ? -1 : 0; run < runs; run++) {
    await rm(join(fixture.root, "host-result.json"), { force: true });
    const child = spawn(executable, ["--verbose", "--skip-welcome", "--skip-release-notes", ...(locale ? [`--locale=${locale}`] : []), ...(process.env.ESKA_HOST_DEBUG_PORT ? [`--remote-debugging-port=${process.env.ESKA_HOST_DEBUG_PORT}`] : []),
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
    // Windows crash reporters can inherit these pipes after the workbench exits.
    // The owned workbench process and its result file determine suite completion.
    const code = await new Promise((resolve, reject) => { child.once("error", reject); child.once("exit", resolve); });
    child.stdout.destroy();
    child.stderr.destroy();
    if (fullLog) await new Promise(resolve => fullLog.end(resolve));
    if (process.env.ESKA_HOST_LOG) await writeFile(process.env.ESKA_HOST_LOG, output);
    // Preserve suite evidence even when the extension test runner exits unsuccessfully.
    if (code !== 0) {
      const result = await readFile(join(fixture.root, "host-result.json"), "utf8").catch(() => "");
      if (result && process.env.ESKA_HOST_FULL_LOG) await writeFile(`${process.env.ESKA_HOST_FULL_LOG}.result.json`, result);
      throw new Error(`Extension host exited ${code}\n${result}\n${output}`);
    }
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
      // Registration may finish after the first startup; repeat only this read-only locale probe.
      if (run === -1 && locale && result.locale?.split('-')[0] !== locale) {
        if (++languageAttempts >= 3) throw new Error(`Language pack did not register ${locale}`);
        run--;
      }
    }
    catch (error) { throw new Error(`Extension host did not report success: ${error.message}\n${output}`); }
  }
} finally { await rm(root, { recursive: true, force: true, maxRetries: process.platform === "win32" ? 20 : 0, retryDelay: 250 }); }
