const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const vscode = require('vscode');
const { revealFile } = require('../out/reveal.js');

/** Wait for the independently started language server and forwarded events. */
async function until(predicate, reason) {
  const deadline = Date.now() + 60000;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.fail(reason);
}

/** Ignore provider object identity when comparing diagnostics across URI schemes. */
function diagnostics(uri) {
  return vscode.languages.getDiagnostics(uri).map(value => ({ message: value.message, severity: value.severity,
    source: value.source, range: [value.range.start.line, value.range.start.character, value.range.end.line, value.range.end.character] }));
}

/** Exercise the installed analyzer on a protected document without ever displaying a native tab. */
exports.run = async function () {
  const fixture = JSON.parse(process.env.ESKA_HOST_FIXTURE);
  const analyzer = vscode.extensions.all.find(extension => extension.packageJSON.name === 'bsl-analyzer-lsp');
  assert.ok(analyzer, 'run with ESKA_BSL_EXTENSION and ESKA_BSL_BINARY');
  const text = 'Функция ЧислоТест()\n    Возврат 1;\nКонецФункции\n\nПроцедура Проверка()\n    Значение = ЧислоТест();\n    Сообщить(Значение);\nКонецПроцедуры\n';
  await fs.writeFile(fixture.module, text);
  const owner = '11111111-1111-1111-1111-111111111111';
  const attribute = '22222222-2222-2222-2222-222222222222';
  const rules = path.join(fixture.source, 'Ext/ParentConfigurations.bin');
  await fs.mkdir(path.dirname(rules), { recursive: true });
  await fs.writeFile(rules, `{6,0,1,${owner},0,${owner},"1","Vendor","Fixture",2,0,0,${owner},${owner},0,0,${attribute},${attribute},0,0,0,1,0,0,0,1,0,1,0,1,1,1,1}`);
  const source = vscode.Uri.file(fixture.module);
  const uri = source.with({ scheme: 'eska-protected' });
  const explorer = await vscode.extensions.all.find(extension => extension.packageJSON.name === 'eska-explorer').activate();
  await vscode.commands.executeCommand('eska.explorer.connect');
  await until(() => explorer.tree && explorer.connection.state.kind === 'ready', 'backend and tree are ready');
  const entry = await revealFile(explorer.tree, fixture.module);
  assert.ok(entry);
  await vscode.commands.executeCommand('eska.explorer.openSource', entry);
  const view = vscode.window.activeTextEditor.document;
  assert.equal(view.uri.toString(), uri.toString(), 'support policy opens a protected module');
  assert.equal(view.languageId, 'bsl');
  let tokens;
  await until(async () => {
    tokens = await vscode.commands.executeCommand('vscode.provideDocumentSemanticTokens', uri);
    return tokens?.data.length > 0;
  }, 'semantic highlighting on the protected URI');
  assert.deepEqual(tokens.data, (await vscode.commands.executeCommand('vscode.provideDocumentSemanticTokens', source)).data);
  assert.deepEqual(await vscode.commands.executeCommand('vscode.provideDocumentSemanticTokensLegend', uri),
    await vscode.commands.executeCommand('vscode.provideDocumentSemanticTokensLegend', source));
  const symbols = await vscode.commands.executeCommand('vscode.executeDocumentSymbolProvider', uri);
  assert.ok(symbols.some(symbol => symbol.name.includes('ЧислоТест')), 'outline comes from the analyzer');
  const position = new vscode.Position(5, 19);
  const hover = await vscode.commands.executeCommand('vscode.executeHoverProvider', uri, position);
  assert.ok(hover.length, 'hover on protected source');
  const definitions = await vscode.commands.executeCommand('vscode.executeDefinitionProvider', uri, position);
  assert.ok(definitions.length, 'go to definition on protected source');
  assert.equal((definitions[0].targetUri ?? definitions[0].uri).toString(), uri.toString(), 'local navigation stays readonly');
  const references = await vscode.commands.executeCommand('vscode.executeReferenceProvider', uri, new vscode.Position(0, 12));
  assert.ok(references.length >= 2, 'references on protected source');
  assert.ok(references.every(location => location.uri.toString() === uri.toString()));
  const folds = await vscode.commands.executeCommand('vscode.executeFoldingRangeProvider', uri);
  assert.ok(folds.length, 'folding comes from the analyzer');
  await vscode.commands.executeCommand('workbench.action.files.setActiveEditorWriteableInSession');
  await vscode.commands.executeCommand('type', { text: '// blocked\n' });
  assert.equal(view.getText(), text, 'language bridge never unlocks the view');
  await assert.rejects(vscode.workspace.fs.writeFile(uri, Buffer.from('// blocked\n')));

  await fs.writeFile(fixture.module, 'Процедура Проверка(\n');
  await until(() => view.getText() === 'Процедура Проверка(\n' && diagnostics(uri).filter(value => value.severity === 0).length >= 2,
    'syntax diagnostics after an external edit');
  assert.deepEqual(diagnostics(uri), diagnostics(source));
  await fs.writeFile(fixture.module, text);
  await until(() => view.getText() === text && !diagnostics(uri).some(value => value.severity === 0), 'diagnostics clear after source repair');
  await until(async () => (await vscode.commands.executeCommand('vscode.provideDocumentSemanticTokens', uri))?.data.length > 0,
    'highlighting survives source changes');
  assert.equal(await fs.readFile(fixture.module, 'utf8'), text);
  assert.ok(!vscode.window.tabGroups.all.flatMap(group => group.tabs).some(tab => tab.input instanceof vscode.TabInputText
    && tab.input.uri.toString() === source.toString()), 'no writable counterpart tab was created');
  await fs.writeFile(path.join(fixture.root, 'host-result.json'), JSON.stringify({ passed: true, suite: 'protected-language',
    vscode: vscode.version, analyzer: analyzer.packageJSON.version, semanticTokens: tokens.data.length / 5,
    outline: true, hover: true, definitions: true, references: true, folding: true, diagnostics: true, readonly: true }));
};
