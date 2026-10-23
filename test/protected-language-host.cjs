const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const vscode = require('vscode');
const { revealFile } = require('../out/reveal.js');
let stage = 'bootstrap';

/** Wait for the independently started language server and forwarded events. */
async function until(predicate, reason) {
  const deadline = Date.now() + 60000;
  while (Date.now() < deadline) {
    try { if (await predicate()) return; }
    catch { /* A replaced or starting provider can cancel a request before it becomes ready. */ }
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
async function run() {
  if (process.env.ESKA_HOST_LOCALE) assert.ok(vscode.env.language.startsWith(process.env.ESKA_HOST_LOCALE),
    `Requested UI locale ${process.env.ESKA_HOST_LOCALE}, actual ${vscode.env.language}`);
  const fixture = JSON.parse(process.env.ESKA_HOST_FIXTURE);
  const analyzer = vscode.extensions.all.find(extension => extension.packageJSON.name === 'bsl-analyzer-lsp');
  const own = process.env.ESKA_HOST_OWN_PROTECTED === '1';
  if (own) { assert.equal(analyzer, undefined); assert.equal(process.env.ESKA_TEST_LANGUAGE, '1'); }
  else assert.ok(analyzer, 'run with ESKA_BSL_EXTENSION and ESKA_BSL_BINARY');
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
  let deniedByPolicy = false;
  if (own) {
    const originalLog = explorer.language.log;
    /** Observe the production write guard's category rather than counting a transient cancellation as a policy rejection. */
    explorer.language.log = (value, level) => {
      if (typeof value === 'string' && value.includes('"event":"language_edit_rejected"') && value.includes('"reason":"readonly"')) deniedByPolicy = true;
      originalLog(value, level);
    };
  }
  if (own) assert.equal(explorer.support.enabled, true);
  await vscode.commands.executeCommand('eska.explorer.connect');
  await until(() => explorer.tree && explorer.connection.state.kind === 'ready', 'backend and tree are ready');
  const entry = await revealFile(explorer.tree, fixture.module);
  assert.ok(entry);
  await vscode.commands.executeCommand('eska.explorer.openSource', entry);
  const view = vscode.window.activeTextEditor.document;
  assert.equal(view.uri.toString(), uri.toString(), 'support policy opens a protected module');
  assert.equal(view.languageId, 'bsl');
  stage = 'language-ready';
  if (own) await until(() => explorer.tooling.states.analyzer.phase === 'ready', 'own LSP ready');
  let tokens;
  stage = 'semantic-tokens';
  await until(async () => {
    tokens = await vscode.commands.executeCommand('vscode.provideDocumentSemanticTokens', uri);
    return tokens?.data.length > 0;
  }, 'semantic highlighting on the protected URI');
  assert.deepEqual(tokens.data, (await vscode.commands.executeCommand('vscode.provideDocumentSemanticTokens', source)).data);
  assert.deepEqual(await vscode.commands.executeCommand('vscode.provideDocumentSemanticTokensLegend', uri),
    await vscode.commands.executeCommand('vscode.provideDocumentSemanticTokensLegend', source));
  stage = 'reading-providers';
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

  stage = 'diagnostics-update';
  await fs.writeFile(fixture.module, 'Процедура Проверка(\n');
  await until(() => view.getText() === 'Процедура Проверка(\n' && diagnostics(uri).filter(value => value.severity === 0).length >= 2,
    'syntax diagnostics after an external edit');
  assert.deepEqual(diagnostics(uri), diagnostics(source));
  await fs.writeFile(fixture.module, text);
  await until(() => view.getText() === text && !diagnostics(uri).some(value => value.severity === 0), 'diagnostics clear after source repair');
  await until(async () => (await vscode.commands.executeCommand('vscode.provideDocumentSemanticTokens', uri))?.data.length > 0,
    'highlighting survives source changes');
  assert.equal(await fs.readFile(fixture.module, 'utf8'), text);
  const ownedPids = [];
  if (own) {
    const client = explorer.language.session.client, originalRequest = client.sendRequest.bind(client);
    stage = 'late-real-hover';
    await until(async () => (await vscode.commands.executeCommand('vscode.executeHoverProvider', uri, position))?.length > 0, 'protected hover is current before delaying a reply');
    let resume, captured, held = false, late;
    const gate = new Promise(resolve => { resume = resolve; });
    /** Delay the real hover reply after upstream computed it; the bridge must still reject a superseded view. */
    client.sendRequest = async (type, ...args) => {
      const result = await originalRequest(type, ...args);
      if ((typeof type === 'string' ? type : type.method) === 'textDocument/hover' && !held) { held = true; captured(); await gate; }
      return result;
    };
    const deadline = Date.now() + 30000;
    // A bridge read may finish empty during source resynchronization; retry completed reads without overlapping pending calls.
    while (!held) {
      const reached = new Promise(resolve => { captured = resolve; });
      const candidate = vscode.commands.executeCommand('vscode.executeHoverProvider', uri, position);
      let timer;
      try {
        const state = await Promise.race([reached.then(() => 'held'), candidate.then(() => 'finished', () => 'finished'),
          new Promise((_resolve, reject) => { timer = setTimeout(() => reject(new Error('real hover capture timed out')), Math.max(1, deadline - Date.now())); })]);
        if (state === 'held') { late = candidate; break; }
      } finally { clearTimeout(timer); }
      assert.ok(Date.now() < deadline, 'real hover reply was captured');
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    await fs.writeFile(fixture.module, '// changed while hover waited\n' + text);
    await until(() => view.getText().startsWith('// changed') && vscode.workspace.textDocuments.some(value => value.uri.toString() === source.toString()
      && value.getText().startsWith('// changed')), 'both source and protected view changed');
    resume(); assert.deepEqual(await late, []); client.sendRequest = originalRequest;
    await fs.writeFile(fixture.module, text);
    await until(() => view.getText() === text, 'protected view restored');
    stage = 'write-denials';
    let rename;
    await until(async () => {
      try { rename = await vscode.commands.executeCommand('vscode.executeDocumentRenameProvider', source, new vscode.Position(0, 12), 'ЗапрещённаяЗамена'); }
      catch (error) { if (!['No result.', 'Результаты отсутствуют.', 'Canceled'].includes(error.message)) throw error; }
      return deniedByPolicy;
    }, 'native alias rename was denied by source policy');
    assert.ok(!rename?.size, 'native file alias cannot rename a locked source');
    assert.equal((await vscode.commands.executeCommand('vscode.executeFormatDocumentProvider', uri, { tabSize: 4, insertSpaces: true }))?.length ?? 0, 0);
    assert.equal((await vscode.commands.executeCommand('vscode.executeCodeActionProvider', uri, fullRange(view)))?.length ?? 0, 0);
    const oldPid = explorer.language.session.owner.child.pid; ownedPids.push(oldPid);
    stage = 'own-restart';
    await explorer.language.restart();
    await until(() => explorer.tooling.states.analyzer.phase === 'ready' && explorer.language.session?.owner?.child.pid !== oldPid, 'own LSP restarted');
    await until(async () => (await vscode.commands.executeCommand('vscode.executeHoverProvider', uri, position))?.length > 0, 'protected hover after own restart');
    await until(async () => (await vscode.commands.executeCommand('vscode.provideDocumentSemanticTokens', uri))?.data.length > 0, 'protected tokens after own restart');
    assert.equal(await fs.readFile(fixture.module, 'utf8'), text);
    ownedPids.push(explorer.language.session.owner.child.pid, explorer.connection.child.pid);
  }
  assert.ok(!vscode.window.tabGroups.all.flatMap(group => group.tabs).some(tab => tab.input instanceof vscode.TabInputText
    && tab.input.uri.toString() === source.toString()), 'no writable counterpart tab was created');
  await fs.writeFile(path.join(fixture.root, 'host-result.json'), JSON.stringify({ passed: true, suite: 'protected-language',
    vscode: vscode.version, locale: vscode.env.language, analyzer: own ? '0.3.2 (own LSP)' : analyzer.packageJSON.version, semanticTokens: tokens.data.length / 5,
    outline: true, hover: true, definitions: true, references: true, folding: true, diagnostics: true, readonly: true,
    own_lsp: own, late_real_hover_rejected: own, own_restart: own, native_alias_rename_denied: own, shutdownPids: ownedPids }));
}

/** Keep failure details available after the isolated host has closed. */
exports.run = async function () {
  try { await run(); }
  catch (error) {
    const fixture = JSON.parse(process.env.ESKA_HOST_FIXTURE);
    await fs.writeFile(path.join(fixture.root, 'host-result.json'), JSON.stringify({ passed: false, error: `${stage}: ${error.stack ?? error}` }));
  }
};

/** Request all possible fixes without synthesizing any write provider for the protected view. */
function fullRange(document) { return new vscode.Range(0, 0, document.lineCount, 0); }
