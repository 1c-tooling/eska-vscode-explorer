import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createProtocolConnection } from "vscode-languageserver-protocol/node";
import { createTreeProject } from "./fixture.mjs";
import { createLanguageSource } from "./language-fixture.mjs";
import { BackendProcess } from "../out/process.js";
import { API_VERSION } from "../out/protocol.js";
import { LanguageProcess } from "../out/language/process.js";

const projectBinary = process.env.ESKA_TEST_BINARY, analyzerBinary = process.env.ESKA_TEST_ANALYZER_BINARY;
if (!projectBinary || !isAbsolute(projectBinary) || !analyzerBinary || !isAbsolute(analyzerBinary)) throw new Error("Set absolute ESKA_TEST_BINARY and ESKA_TEST_ANALYZER_BINARY.");
const root = await mkdtemp(join(process.env.ESKA_TEST_ROOT ?? resolve("../eska-playground"), "t86-lsp-probe-"));
const fixture = await createTreeProject(join(root, "project"));
const { file, text } = await createLanguageSource(fixture);
const logs = [], notifications = [], diagnostics = new Map();
const log = value => { if (logs.length < 200) logs.push(value); };
const metadata = new BackendProcess({ executable: projectBinary, cwd: fixture.root, log, failed() {} });
let lease, owner, protocol;

/** Raw protocol probes have explicit deadlines and leave cleanup to the exact owned process. */
async function request(method, params) {
  const deadline = Date.now() + 15_000;
  while (true) {
    let timer;
    try { return await Promise.race([params === null ? protocol.sendRequest(method) : protocol.sendRequest(method, params), new Promise((_resolve, reject) => { timer = setTimeout(() => reject(new Error(`LSP timeout: ${method}`)), Math.max(1, deadline - Date.now())); })]); }
    catch (error) {
      if (error.code !== -32801 || Date.now() >= deadline) throw error;
      await new Promise(resolve => setTimeout(resolve, 50));
    } finally { clearTimeout(timer); }
  }
}

/** A diagnostic transition must belong to the opened source URI, never another workspace file. */
async function until(predicate, label) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) { if (predicate()) return; await new Promise(resolve => setTimeout(resolve, 30)); }
  throw new Error(label);
}

try {
  await metadata.request("initialize", { apiVersion: API_VERSION, client: { name: "eska-explorer", version: "native-language-probe" }, locale: "en-US", allowPropertyEdits: true });
  const start = { value: fixture.root, encoding: "utf-8" };
  const context = await metadata.request("analyzer/context", { start });
  const status = await metadata.request("analyzer/configStatus", { start });
  const prepared = await metadata.request("analyzer/configPrepare", { start, analyzer: { value: analyzerBinary, encoding: "utf-8" } });
  lease = await metadata.request("analyzer/acquire", { start });
  owner = new LanguageProcess(analyzerBinary, context.context.root.value, log, () => {});
  protocol = createProtocolConnection(owner.child.stdout, owner.child.stdin);
  protocol.onRequest((method, _params) => {
    if (method === "workspace/workspaceFolders") return [{ uri: pathToFileURL(context.context.root.value).href, name: "probe" }];
    if (method === "workspace/configuration") return [];
    return null;
  });
  protocol.onNotification((method, params) => {
    if (notifications.length < 200) notifications.push({ method, params });
    if (method === "textDocument/publishDiagnostics") diagnostics.set(params.uri, params);
  });
  protocol.listen();
  const hello = await request("initialize", { processId: process.pid, rootUri: pathToFileURL(context.context.root.value).href,
    workspaceFolders: [{ uri: pathToFileURL(context.context.root.value).href, name: "probe" }],
    capabilities: { general: { positionEncodings: ["utf-16"] }, window: { workDoneProgress: true }, workspace: { workspaceFolders: true, workspaceEdit: { documentChanges: true } },
      textDocument: { publishDiagnostics: { versionSupport: true }, hover: { contentFormat: ["markdown", "plaintext"] }, completion: { completionItem: { snippetSupport: true } } } }, clientInfo: { name: "eska-native-probe", version: "1" } });
  assert.equal(hello.serverInfo.name, "bsl-analyzer"); assert.equal(hello.serverInfo.version, "0.3.2");
  await writeFile(join(root, "hello.json"), JSON.stringify(hello, null, 2) + "\n");
  await protocol.sendNotification("initialized", {});
  const uri = pathToFileURL(file).href;
  await protocol.sendNotification("textDocument/didOpen", { textDocument: { uri, languageId: "bsl", version: 1, text } });
  const symbols = await request("textDocument/documentSymbol", { textDocument: { uri } });
  assert.ok(symbols.some(symbol => symbol.name === "Проверка"));
  const hover = await request("textDocument/hover", { textDocument: { uri }, position: { line: 5, character: 15 } });
  const definition = await request("textDocument/definition", { textDocument: { uri }, position: { line: 5, character: 15 } });
  assert.ok(hover && JSON.stringify(hover).includes("Проверка"));
  const locations = Array.isArray(definition) ? definition : definition ? [definition] : [];
  assert.ok(locations.length);
  assert.equal(fileURLToPath(locations[0].uri ?? locations[0].targetUri), file);
  assert.equal((locations[0].range ?? locations[0].targetSelectionRange).start.line, 1);
  await protocol.sendNotification("textDocument/didChange", { textDocument: { uri, version: 2 }, contentChanges: [{ text: text + "Функция Сломано(\n" }] });
  const syntaxLine = text.split("\n").length - 1;
  const syntaxError = value => value.code === "ParseError" && value.range.start.line >= syntaxLine;
  await until(() => (diagnostics.get(uri)?.diagnostics ?? []).some(syntaxError), "unsaved syntax diagnostics");
  const broken = diagnostics.get(uri);
  await protocol.sendNotification("textDocument/didChange", { textDocument: { uri, version: 3 }, contentChanges: [{ text }] });
  await until(() => diagnostics.has(uri) && !(diagnostics.get(uri).diagnostics ?? []).some(syntaxError), "repaired diagnostics");
  const report = { passed: true, root, context, status, prepared, lease, hello, symbols, hover, definition, broken_diagnostics: broken,
    repaired_diagnostics: diagnostics.get(uri), source_unchanged: await readFile(file, "utf8") === text, pid: owner.child.pid };
  await request("shutdown", null); await protocol.sendNotification("exit");
  await owner.stop();
  assert.equal(owner.child.exitCode, 0); assert.equal(owner.child.signalCode, null);
  assert.equal(report.source_unchanged, true);
  report.shutdown = { exit_code: owner.child.exitCode, signal: owner.child.signalCode };
  await metadata.request("analyzer/release", { leaseId: lease.leaseId }); lease = undefined;
  await writeFile(join(root, "report.json"), JSON.stringify(report, null, 2) + "\n");
  console.log(JSON.stringify({ root, report: join(root, "report.json"), passed: true }));
} finally {
  protocol?.dispose(); await owner?.stop();
  if (lease) await metadata.request("analyzer/release", { leaseId: lease.leaseId }).catch(() => {});
  await metadata.stop(); await writeFile(join(root, "logs.json"), JSON.stringify({ logs, notifications }, null, 2) + "\n");
}
