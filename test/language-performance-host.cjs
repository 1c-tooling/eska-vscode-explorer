const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const vscode = require('vscode');

/** Wait for a real provider response while retaining a bounded startup deadline. */
async function ready(operation, timeout = 240000) {
  const end = Date.now() + timeout;
  let last;
  while (Date.now() < end) {
    try {
      const result = await operation();
      if (result?.length) return result;
    } catch (error) { last = error; }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`Provider did not become ready: ${last ?? 'empty result'}`);
}

/** Include asynchronous editor/provider completion in each measured latency. */
async function timed(operation) {
  const start = performance.now();
  const result = await operation();
  return { milliseconds: performance.now() - start, result };
}

/** Observe diagnostics events without adding a polling interval to measured latency. */
async function diagnosticsReady(uri, predicate) {
  if (predicate(vscode.languages.getDiagnostics(uri))) return;
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { subscription.dispose(); reject(new Error('Diagnostics deadline')); }, 30000);
    const subscription = vscode.languages.onDidChangeDiagnostics(event => {
      if (event.uris.some(value => value.toString() === uri.toString()) && predicate(vscode.languages.getDiagnostics(uri))) {
        clearTimeout(timer); subscription.dispose(); resolve();
      }
    });
  });
}

/** Measure the same existing module in an isolated copy of the full application. */
exports.run = async function () {
  const start = performance.now(), runnerStartedUnixMs = performance.timeOrigin + start;
  const fixture = JSON.parse(process.env.ESKA_HOST_FIXTURE);
  const input = JSON.parse(await fs.readFile(path.join(process.env.T89_RUN, 'input.json'), 'utf8'));
  const explorerExtension = vscode.extensions.all.find(value => value.packageJSON.name === 'eska-explorer');
  const analyzerExtension = vscode.extensions.all.find(value => value.packageJSON.name === 'bsl-analyzer-lsp');
  const own = process.env.T89_VARIANT === 'candidate';
  assert.ok(explorerExtension); assert.equal(Boolean(analyzerExtension), !own);
  const explorer = await explorerExtension.activate();
  assert.equal(explorer.support.enabled, false, 'same support-policy setting');
  await vscode.commands.executeCommand('eska.explorer.connect');
  const root = (await explorer.getChildren())[0];
  const rows = await explorer.getChildren(root);
  assert.ok(rows.length > 5);
  const treeReadyMs = performance.now() - start;
  const uri = vscode.Uri.file(path.join(input.copy, input.probe));
  const disk = await fs.readFile(uri.fsPath);
  const documentRequestedUnixMs = performance.timeOrigin + performance.now();
  const document = await vscode.workspace.openTextDocument(uri);
  await vscode.window.showTextDocument(document);
  if (analyzerExtension) await analyzerExtension.activate();
  const position = new vscode.Position(5, 18);
  await ready(() => vscode.commands.executeCommand('vscode.executeDefinitionProvider', uri, position));
  const languageReadyMs = performance.now() - start;
  const languageReadyUnixMs = performance.timeOrigin + performance.now();
  const samples = { hover: [], completion: [], definition: [], editDiagnostics: [] };
  for (let index = 0; index < 30; index++) {
    for (const [key, command, args] of [
      ['hover', 'vscode.executeHoverProvider', [uri, position]],
      ['completion', 'vscode.executeCompletionItemProvider', [uri, new vscode.Position(6, 8)]],
      ['definition', 'vscode.executeDefinitionProvider', [uri, position]],
    ]) {
      const sample = await timed(() => vscode.commands.executeCommand(command, ...args));
      assert.ok(sample.result?.length || sample.result?.items?.length, `${key} returned a non-empty response`);
      if (key === 'hover') assert.ok(sample.result.some(value => value.contents.some(content => (typeof content === 'string' ? content : content.value).includes('ESKABaseline'))), 'hover identifies the probe function');
      if (key === 'completion') assert.ok(sample.result.items.some(item => (typeof item.label === 'string' ? item.label : item.label.label) === 'Сообщить'), 'completion contains the called platform method');
      if (key === 'definition') assert.ok(sample.result.some(value => (value.targetUri ?? value.uri).toString() === uri.toString() && (value.targetSelectionRange ?? value.range).start.line === 0), 'definition targets the actual probe function');
      samples[key].push(sample.milliseconds);
    }
    const previous = document.getText(), offset = document.positionAt(previous.length);
    const marker = `ESKABenchmarkRepair${index}`;
    const repairedText = disk.toString('utf8').replace(/\nКонецПроцедуры\n$/, `\n    ${marker} = 1;\nКонецПроцедуры\n`);
    assert.notEqual(repairedText, disk.toString('utf8'), 'the diagnostic sentinel is inside the actual procedure');
    const sample = await timed(async () => {
      const changed = new vscode.WorkspaceEdit();
      changed.insert(uri, offset, `\nПроцедура ESKABroken${index}(\n`);
      assert.equal(await vscode.workspace.applyEdit(changed), true);
      await diagnosticsReady(uri, values => values.some(value => (typeof value.code === 'object' ? value.code.value : value.code) === 'ParseError'));
      const repaired = new vscode.WorkspaceEdit();
      repaired.replace(uri, new vscode.Range(0, 0, document.lineCount, 0), repairedText);
      assert.equal(await vscode.workspace.applyEdit(repaired), true);
      // An empty collection can be an editor-side invalidation. A unique semantic diagnostic proves a fresh upstream result.
      await diagnosticsReady(uri, values => !values.some(value => value.severity === vscode.DiagnosticSeverity.Error)
        && values.some(value => value.message.includes(marker)));
    });
    samples.editDiagnostics.push(sample.milliseconds);
    assert.equal(document.getText(), repairedText);
  }
  const idleStartedUnixMs = performance.timeOrigin + performance.now();
  await new Promise(resolve => setTimeout(resolve, 5000));
  const idleEndedUnixMs = performance.timeOrigin + performance.now();
  const steadyHover = [];
  for (let index = 0; index < 30; index++) {
    const sample = await timed(() => vscode.commands.executeCommand('vscode.executeHoverProvider', uri, position));
    assert.ok(sample.result?.some(value => value.contents.some(content => (typeof content === 'string' ? content : content.value).includes('ESKABaseline'))));
    steadyHover.push(sample.milliseconds);
  }
  assert.deepEqual(await fs.readFile(uri.fsPath), disk);
  const result = { diagnostic_freshness_sentinel: true, phase_times: { runnerStartedUnixMs, documentRequestedUnixMs, languageReadyUnixMs, idleStartedUnixMs, idleEndedUnixMs }, steadyHover, disk_unchanged: true, passed: true, suite: 't89-buhmfo', variant: process.env.T89_VARIANT, treeReadyMs, languageReadyMs, samples,
    hostPid: process.pid, backendPid: explorer.connection.child.pid, vscode: vscode.version,
    explorerVersion: explorerExtension.packageJSON.version, externalExtensionVersion: analyzerExtension?.packageJSON.version ?? null,
    hostMemory: process.memoryUsage(), mode: process.env.T89_MODE, round: Number(process.env.T89_ROUND) };
  await fs.writeFile(path.join(process.env.T89_RUN, `editor-${result.mode}-${result.round}.json`), JSON.stringify(result, null, 2));
  await fs.writeFile(path.join(fixture.root, 'host-result.json'), JSON.stringify(result));
};
