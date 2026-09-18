const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const vscode = require('vscode');

/** Wait for the independent language server, reporting missing features as failures. */
async function until(predicate, message) {
  const deadline = Date.now() + 60000;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(message);
}
/** Capture stable diagnostics without volatile object identities. */
function diagnostics(uri) {
  return vscode.languages.getDiagnostics(uri).map(value => ({ message: value.message, severity: value.severity,
    range: [value.range.start.line, value.range.start.character, value.range.end.line, value.range.end.character] }));
}
/** Compare language features before and after connecting Explorer in an isolated combined profile. */
exports.run = async function () {
  const fixture = JSON.parse(process.env.ESKA_HOST_FIXTURE);
  const analyzer = vscode.extensions.all.find(value => value.packageJSON.name === 'bsl-analyzer-lsp');
  assert.ok(analyzer);
  const settingsPath = path.join(fixture.root, '.vscode', 'settings.json');
  const settings = await fs.readFile(settingsPath, 'utf8');
  const debugTypes = analyzer.packageJSON.contributes.debuggers.map(value => value.type);
  await fs.writeFile(fixture.module, 'Процедура Проверка()\nСообщить("Тест");\nКонецПроцедуры\n');
  const uri = vscode.Uri.file(fixture.module);
  const document = await vscode.workspace.openTextDocument(uri);
  await vscode.window.showTextDocument(document);
  assert.equal(document.languageId, 'bsl');
  await analyzer.activate();
  let completions;
  await until(async () => {
    completions = await vscode.commands.executeCommand('vscode.executeCompletionItemProvider', uri, new vscode.Position(1, 4));
    return completions?.items.length > 0;
  }, 'baseline BSL completion');
  const labels = completions.items.map(item => typeof item.label === 'string' ? item.label : item.label.label).sort();
  const format = await vscode.commands.executeCommand('vscode.executeFormatDocumentProvider', uri, { tabSize: 4, insertSpaces: true });
  assert.ok(format?.length, 'baseline BSL formatting');
  // An invalid statement makes diagnostic availability observable even with minimal fixture metadata.
  await fs.writeFile(fixture.module, 'Процедура Проверка(\n');
  await until(() => document.getText() === 'Процедура Проверка(\n'
    && diagnostics(uri).filter(value => value.severity === vscode.DiagnosticSeverity.Error).length >= 2, 'baseline BSL syntax diagnostics');
  const beforeDiagnostics = diagnostics(uri);
  const extension = vscode.extensions.all.find(value => value.packageJSON.name === 'eska-explorer');
  await vscode.workspace.getConfiguration('eska.explorer').update('executable', process.env.ESKA_TEST_BINARY, vscode.ConfigurationTarget.Global);
  const explorer = await extension.activate();
  await vscode.commands.executeCommand('eska.explorer.connect');
  const [root] = await explorer.getChildren();
  const catalogs = (await explorer.getChildren(root)).find(entry => entry.node?.id.collection?.metadataKind === 'catalog');
  const goods = (await explorer.getChildren(catalogs)).find(entry => entry.node.label.text === 'Товары');
  const modules = (await explorer.getChildren(goods)).find(entry => entry.node?.id.collection?.kind === 'modules');
  const [module] = await explorer.getChildren(modules);
  await vscode.commands.executeCommand('eska.explorer.openSource', module);
  assert.equal(vscode.window.activeTextEditor.document.uri.fsPath, fixture.module);
  assert.deepEqual(diagnostics(uri), beforeDiagnostics);
  await fs.writeFile(fixture.module, 'Процедура Проверка()\nСообщить("Тест");\nКонецПроцедуры\n');
  await until(() => document.getText().includes('Сообщить')
    && !diagnostics(uri).some(value => value.severity === vscode.DiagnosticSeverity.Error), 'document and analyzer restored');
  const after = await vscode.commands.executeCommand('vscode.executeCompletionItemProvider', uri, new vscode.Position(1, 4));
  assert.deepEqual(after.items.map(item => typeof item.label === 'string' ? item.label : item.label.label).sort(), labels);
  assert.deepEqual(await vscode.commands.executeCommand('vscode.executeFormatDocumentProvider', uri, { tabSize: 4, insertSpaces: true }), format);
  assert.equal(await fs.readFile(settingsPath, 'utf8'), settings, 'external settings unchanged');
  assert.deepEqual(analyzer.packageJSON.contributes.debuggers.map(value => value.type), debugTypes);
  assert.equal(extension.packageJSON.contributes.debuggers, undefined);
  await vscode.commands.executeCommand('eska.explorer.disconnect');
  await fs.writeFile(path.join(fixture.root, 'host-result.json'), JSON.stringify({ passed: true, suite: 'compatibility', vscode: vscode.version,
    analyzer: analyzer.packageJSON.version, debugTypes, debuggerSession: 'not tested; no 1C runtime' }));
};
