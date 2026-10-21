const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const { execFile } = require("node:child_process");
const { createHash } = require("node:crypto");
const vscode = require("vscode");
let stage = "bootstrap";

/** Wait for exact diagnostics rather than treating an empty editor collection as completion. */
async function until(operation, label) {
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    const value = await operation();
    if (value) return value;
    await new Promise(done => setTimeout(done, 50));
  }
  throw new Error(label);
}

/** Keep the complete CLI result even when the configured diagnostic threshold returns exit 1. */
async function check(fixture, locale) {
  return new Promise((resolve, reject) => {
    execFile(process.env.ESKA_TEST_CHECK_BINARY, ["--lang", locale, "--project-dir", fixture.root, "--format", "json",
      "--analyzer", process.env.ESKA_TEST_ANALYZER_BINARY], { timeout: 60000, maxBuffer: 4 * 1024 * 1024,
      env: { ...process.env, PATH: "/usr/bin:/bin", ESKA_PROJECT_BINARY: path.join(fixture.root, "missing-project") } }, (error, stdout, stderr) => {
      if (error && ![0, 1].includes(error.code)) { reject(new Error(`CLI ${locale}: ${error.message}\n${stderr}\n${stdout}`)); return; }
      resolve({ exit: error?.code ?? 0, stdout, stderr });
    });
  });
}

/** Normalize presentation wrappers while retaining all actual diagnostic content, severity and positions. */
function editorDiagnostics(uri) {
  return vscode.languages.getDiagnostics(uri).map(value => ({ code: typeof value.code === "object" ? value.code.value : value.code,
    message: value.message.replace(/ \(Стандарт \d+: https:\/\/v8std\.ru\/std\/\d+\/\)$/, ""), severity: ["Error", "Warning", "Information", "Hint"][value.severity],
    start_line: value.range.start.line, start_column: value.range.start.character,
    end_line: value.range.end.line, end_column: value.range.end.character })).sort(compare);
}

/** Canonical ordering makes the comparison independent of server publication order. */
function compare(a, b) { return JSON.stringify(a).localeCompare(JSON.stringify(b), "en"); }

/** Prove CLI/LSP parity with the real checker, actual managed config and every BSL file in this small context. */
async function run() {
  assert.equal(process.env.ESKA_HOST_LANGUAGE_PARITY, "1");
  assert.ok(path.isAbsolute(process.env.ESKA_TEST_CHECK_BINARY));
  const fixture = JSON.parse(process.env.ESKA_HOST_FIXTURE);
  const files = [path.join(fixture.source, "CommonModules", "Обмен", "Ext", "Module.bsl"), fixture.module];
  const sourceBytes = await Promise.all(files.map(file => fs.readFile(file)));
  const explorer = await vscode.extensions.all.find(value => value.packageJSON.name === "eska-explorer").activate();
  await until(() => explorer.connection.state.kind === "ready", "metadata ready");
  assert.equal(explorer.support.enabled, true);
  const views = [];
  for (const [index, file] of files.entries()) {
    const document = await vscode.workspace.openTextDocument(vscode.Uri.file(file));
    assert.equal(document.languageId, "bsl");
    assert.ok(document.getText().includes(`ESKAParitySentinel${index}`));
    await vscode.window.showTextDocument(document, { preview: false });
    views.push(document.uri);
    await until(() => explorer.tooling.states.analyzer.phase === "ready", "own LSP ready for the visible document");
    // The editor may cache an early cancelled symbol request. Await the actual selected client before comparing pushes.
    await until(async () => {
      try {
        const symbols = await explorer.language.session.client.sendRequest("textDocument/documentSymbol", { textDocument: { uri: document.uri.toString() } });
        return symbols?.some(value => value.name === `ESKAParity${index}`);
      } catch (error) {
        if (error.name !== "Canceled" && error.code !== -32800 && error.code !== -32801) throw error;
        return false;
      }
    }, "the native document reaches the selected language server");
  }
  await until(() => explorer.tooling.states.analyzer.phase === "ready", "own LSP ready");
  const pid = explorer.language.session.owner.child.pid, metadataPid = explorer.connection.child.pid;
  const configuration = path.join(fixture.root, "bsl-analyzer.toml"), original = await fs.readFile(configuration);
  stage = "cli-analysis";
  const russian = await check(fixture, "ru"), english = await check(fixture, "en");
  if (process.env.ESKA_HOST_PARITY_REPORT) await fs.writeFile(process.env.ESKA_HOST_PARITY_REPORT + ".cli.json", JSON.stringify({ russian, english }, null, 2));
  assert.equal(russian.stdout, english.stdout, "CLI locale does not change the semantic report");
  assert.equal(russian.exit, english.exit);
  const report = JSON.parse(russian.stdout);
  assert.equal(report.complete, true); assert.equal(report.scope, "full");
  assert.equal(report.analyzer.version, "0.3.2");
  assert.equal(report.context.root.value, explorer.language.session.context.root);
  assert.equal(report.context.application, explorer.language.session.context.name);
  assert.deepEqual(report.files.map(file => file.path.value).sort(), [...files].sort(), "the whole selected BSL set is analyzed");
  stage = "native-diagnostic-parity";
  const compared = [];
  for (const [index, file] of files.entries()) {
    const expected = report.files.find(value => value.path.value === file).diagnostics.map(value => ({ code: value.code,
      message: value.message, severity: value.severity, start_line: value.start_line, start_column: value.start_column,
      end_line: value.end_line, end_column: value.end_column })).sort(compare);
    assert.ok(expected.some(value => value.message.includes(`ESKAParitySentinel${index}`)));
    const uri = views[index];
    try {
      await until(() => {
        const actual = editorDiagnostics(uri);
        return actual.some(value => value.message.includes(`ESKAParitySentinel${index}`)) && JSON.stringify(actual) === JSON.stringify(expected);
      }, `fresh exact CLI/LSP diagnostics for ${path.basename(path.dirname(path.dirname(file)))}`);
    } finally {
      if (process.env.ESKA_HOST_PARITY_REPORT) await fs.writeFile(process.env.ESKA_HOST_PARITY_REPORT + `.compare${index}.json`,
        JSON.stringify({ file, expected, actual: editorDiagnostics(uri), raw_messages: vscode.languages.getDiagnostics(uri).map(value => value.message) }, null, 2));
    }
    compared.push({ file, diagnostics: expected });
    assert.deepEqual(await fs.readFile(file), sourceBytes[index]);
  }
  assert.deepEqual(await fs.readFile(configuration), original, "concurrent complete CLI analysis preserves the leased config");
  assert.equal(explorer.language.session.owner.child.pid, pid); assert.equal(explorer.connection.child.pid, metadataPid);
  const result = { passed: true, suite: "language-parity", vscode: vscode.version, real_cli_and_lsp: true,
    policy_enabled: true, full_context_files: files.length, equal_diagnostic_codes_severities_ranges: true, equal_semantic_messages: true,
    message_normalization: "Only the upstream LSP suffix (Стандарт N: https://v8std.ru/std/N/) is removed; raw messages are retained",
    cli_locales_identical: true, cli_exit: russian.exit, config_unchanged: true,
    config_sha256: createHash("sha256").update(original).digest("hex"), compared, shutdownPids: [pid, metadataPid] };
  if (process.env.ESKA_HOST_PARITY_REPORT) await fs.writeFile(process.env.ESKA_HOST_PARITY_REPORT, JSON.stringify({ result, cli: report }, null, 2));
  await fs.writeFile(path.join(fixture.root, "host-result.json"), JSON.stringify(result));
}

/** Preserve the failing phase after the runner removes its disposable fixture. */
exports.run = async function () {
  try { await run(); }
  catch (error) {
    const fixture = JSON.parse(process.env.ESKA_HOST_FIXTURE);
    await fs.writeFile(path.join(fixture.root, "host-result.json"), JSON.stringify({ passed: false, error: `${stage}: ${error.stack ?? error}` }));
  }
};
