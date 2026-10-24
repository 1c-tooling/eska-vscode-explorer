const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const vscode = require('vscode');

/** Wait for a real published-server response without accepting an indexing-time empty result. */
async function until(operation, label, timeout = 180000) {
  const deadline = Date.now() + timeout; let last;
  while (Date.now() < deadline) { try { const result = await operation(); if (result) return result; } catch (error) { last = error; } await new Promise(resolve => setTimeout(resolve, 20)); }
  throw new Error(`${label}: ${last ?? 'deadline'}`);
}

/** Include the complete native operation and acknowledgement in each timing. */
async function timed(samples, key, operation) {
  const start = performance.now(), result = await operation(); (samples[key] ??= []).push(performance.now() - start); return result;
}

/** Every input change uses the native undo stack and exact current offsets. */
async function replace(document, before, after) {
  const start = document.getText().indexOf(before); assert.ok(start >= 0, before);
  const edit = new vscode.WorkspaceEdit(); edit.replace(document.uri, new vscode.Range(document.positionAt(start), document.positionAt(start + before.length)), after);
  assert.equal(await vscode.workspace.applyEdit(edit), true);
}

/** The response must contain the actual expected metadata field, rather than any completion item. */
async function completion(document, prefix, label) {
  const at = document.getText().indexOf(prefix); assert.ok(at >= 0, prefix);
  const result = await vscode.commands.executeCommand('vscode.executeCompletionItemProvider', document.uri, document.positionAt(at + prefix.length));
  return result?.items.find(item => (typeof item.label === 'string' ? item.label : item.label.label) === label);
}

/** Private storage measurements exclude unrelated extension data and include all retained checkpoint files. */
async function storage(directory) {
  let bytes = 0, files = 0;
  try { for (const row of await fs.readdir(directory, { withFileTypes: true })) {
    const file = path.join(directory, row.name); if (row.isDirectory()) { const child = await storage(file); bytes += child.bytes; files += child.files; }
    else if (row.isFile()) { bytes += (await fs.stat(file)).size; files++; }
  } } catch (error) { if (error.code !== 'ENOENT') throw error; }
  return { bytes, files };
}

/** Linux process snapshots complement the independent whole-window sampler, with explicit process identities. */
async function memory(pids) {
  const rows = {};
  for (const [name, pid] of Object.entries(pids)) {
    const text = await fs.readFile(`/proc/${pid}/smaps_rollup`, 'utf8');
    rows[name] = Object.fromEntries(['Rss', 'Pss'].map(key => [key, Number(new RegExp(`^${key}:\\s+(\\d+)`, 'm').exec(text)[1]) * 1024]));
  }
  return { unixMs: Date.now(), heap: process.memoryUsage(), processes: rows };
}

/** Count live adapter resources separately from the editor's own temporary text-model cache. */
function clientState(explorer) {
  const language = explorer.language.queryLanguage;
  return { sessions: explorer.queries.sessions.size, constructors: explorer.queryDesigner.views.size,
    languageViews: language.views.size, languageTasks: language.tasks.size, languageTimers: language.timers.size,
    languageStates: language.states.size, languageStreams: explorer.language.session.documents.streams.size,
    nativeDraftModels: vscode.workspace.textDocuments.filter(value => value.uri.scheme === 'eska-query').length };
}

/** Compare ordinary BSL and private SDBL against the same query, metadata application and published LSP. */
exports.run = async function () {
  const input = JSON.parse(await fs.readFile(process.env.ESKA_QUERY_PERF_INPUT, 'utf8'));
  const operations = input.operations ?? 30; assert.ok(Number.isInteger(operations) && operations >= 1 && operations <= 100);
  const fixture = JSON.parse(process.env.ESKA_HOST_FIXTURE), samples = Object.create(null), rounds = [], started = performance.now(), errors = [], rpc = Object.create(null);
  let explorer, owner, disk, watchdog;
  try {
    assert.equal(vscode.env.language, process.env.ESKA_QUERY_PERF_LOCALE ?? process.env.ESKA_HOST_LOCALE ?? 'en');
    explorer = await vscode.extensions.all.find(value => value.packageJSON.name === 'eska-explorer').activate();
    watchdog = setInterval(() => {
      void fs.writeFile(path.join(fixture.root, 'health.json'), JSON.stringify({ metadata: explorer.connection.state.kind,
        tooling: explorer.tooling.states, selectedApplication: explorer.language.selectedApplication,
        queryStates: [...explorer.language.queryLanguage.states.entries()].map(([document, state]) => ({ uri: document.uri.toString(), state })),
        queryHeaders: [...explorer.queries.sessions.values()].map(session => session.source?.header),
        progress: explorer.language.session?.progress })).catch(() => {});
    }, 1000);
    await until(() => explorer.tree && explorer.connection.state.kind === 'ready' && !explorer.support.loading, 'metadata ready');
    const metadataReadyMs = performance.now() - started, send = explorer.connection.child.request.bind(explorer.connection.child);
    explorer.connection.child.request = (method, ...args) => { rpc[method] = (rpc[method] ?? 0) + 1; return send(method, ...args); };
    const explain = explorer.queries.explain.bind(explorer.queries);
    explorer.queries.explain = error => { errors.push({ code: error.code, details: error.details }); explain(error); };
    disk = await fs.readFile(input.module); owner = await vscode.workspace.openTextDocument(vscode.Uri.file(input.module));
    const original = owner.getText(), query = input.mode === 'query', prefixA = input.prefixA, prefixB = input.prefixB;
    await vscode.window.showTextDocument(owner, { preview: false });
    const open = async () => {
      owner = await vscode.workspace.openTextDocument(vscode.Uri.file(input.module));
      const editor = await vscode.window.showTextDocument(owner, { preview: false });
      if (!query) return owner;
      const position = owner.positionAt(owner.getText().indexOf('SELECT ') + 3); editor.selection = new vscode.Selection(position, position);
      await vscode.commands.executeCommand('eska.explorer.editBslQuery');
      return until(() => vscode.window.activeTextEditor?.document.uri.scheme === 'eska-query' && vscode.window.activeTextEditor.document, 'query tab');
    };
    let document = await timed(samples, 'open', open);
    await timed(samples, 'firstCompletion', () => until(() => completion(document, prefixA, input.labelA), 'first metadata completion'));
    const languageReadyMs = performance.now() - started, session = explorer.language.session;
    const progressEvents = [], registerProgress = session.client.onProgress.bind(session.client);
    session.client.onProgress = (type, token, handler) => registerProgress(type, token, value => {
      progressEvents.push({ unixMs: Date.now(), token, ...value }); return handler(value);
    });
    const pids = { extensionHost: process.pid, project: explorer.connection.child.pid, analyzer: session.owner.child.pid };
    const initialMemory = await memory(pids), initialStorage = await storage(explorer.queries.directory);
    if (input.readOnly) {
      assert.equal((await vscode.workspace.fs.stat(document.uri)).permissions, vscode.FilePermission.Readonly);
      await vscode.commands.executeCommand('eska.explorer.queryConstructor', document.uri);
      const view = explorer.queryDesigner.views.get(document.uri.toString()); assert.ok(view); assert.equal(view.binding.core.model.writable, false);
      await assert.rejects(view.binding.core.action({ kind: 'append', statement: 0, clause: 'fields', text: '9' }), error => error.details?.reason === 'user_read_only');
      await explorer.queryDesigner.receive(view, { type: 'apply' }); document = vscode.window.activeTextEditor.document;
      await vscode.commands.executeCommand('eska.explorer.applyQuery', document.uri);
      assert.ok(errors.some(error => ['user_read_only', 'read_only'].includes(error.details?.reason)));
      await vscode.commands.executeCommand('eska.explorer.cancelQuery', document.uri);
      assert.equal(owner.getText(), original); assert.deepEqual(await fs.readFile(input.module), disk);
      await fs.writeFile(path.join(fixture.root, 'host-result.json'), JSON.stringify({ passed: true, suite: 'support-locked-query', input, locale: vscode.env.language,
        metadataCompletionFromReadonlySource: true, constructorCannotGrantWrite: true, nativeAndDiskUnchanged: true, errors, samples }));
      return;
    }
    const isParseError = value => String(value.code?.value ?? value.code).includes('QueryParseError');
    for (let index = 0; index < operations; index++) {
      if (index) document = await timed(samples, 'open', open);
      await timed(samples, 'editCompletion', async () => {
        await replace(document, prefixA, prefixB);
        await until(() => completion(document, prefixB, input.labelB), 'changed metadata completion');
      });
      await timed(samples, 'editDiagnostics', async () => {
        await replace(document, 'SELECT ' + prefixB, 'SELECT FROM');
        await until(() => vscode.languages.getDiagnostics(document.uri).some(isParseError), 'fresh query parse diagnostic', 30000);
      });
      await timed(samples, 'repairCompletion', async () => {
        await replace(document, 'SELECT FROM', 'SELECT ' + prefixA);
        await until(() => completion(document, prefixA, input.labelA), 'repaired real completion');
        await until(() => !vscode.languages.getDiagnostics(document.uri).some(isParseError), 'repaired diagnostics', 30000);
      });
      if (query) {
        await timed(samples, 'constructor', async () => {
          await vscode.commands.executeCommand('eska.explorer.queryConstructor', document.uri);
          const view = explorer.queryDesigner.views.get(document.uri.toString()); assert.ok(view);
          await explorer.queryDesigner.receive(view, { type: 'action', action: { kind: 'append', statement: 0, clause: 'fields', text: `${index + 10} AS Bench` } });
          await explorer.queryDesigner.receive(view, { type: 'apply' }); document = vscode.window.activeTextEditor.document;
          assert.ok(document.getText().includes(`${index + 10} AS Bench`));
        });
        await timed(samples, 'apply', () => vscode.commands.executeCommand('eska.explorer.applyQuery', document.uri));
        assert.ok(owner.getText().includes(`${index + 10} AS Bench`)); assert.equal(owner.isDirty, true);
        await vscode.window.showTextDocument(owner); await vscode.commands.executeCommand('undo'); assert.equal(owner.getText(), original);
        assert.equal(explorer.queries.sessions.size, 0); assert.equal(explorer.queryDesigner.views.size, 0);
        // A separate open/cancel cycle measures release without using a Source Apply receipt.
        document = await timed(samples, 'openForCancel', open);
        await timed(samples, 'cancel', () => vscode.commands.executeCommand('eska.explorer.cancelQuery', document.uri));
      } else {
        assert.equal(owner.getText(), original);
        await timed(samples, 'close', async () => { await vscode.commands.executeCommand('workbench.action.revertAndCloseActiveEditor'); });
      }
      assert.equal(explorer.connection.child.pid, pids.project); assert.equal(explorer.language.session.owner.child.pid, pids.analyzer);
      assert.equal(explorer.language.session.progress.busy, false);
      if (index % 5 === 4) rounds.push({ index: index + 1, memory: await memory(pids), storage: await storage(explorer.queries.directory),
        sessionCount: explorer.queries.sessions.size, constructorCount: explorer.queryDesigner.views.size, client: clientState(explorer) });
      await fs.writeFile(path.join(fixture.root, 'progress.json'), JSON.stringify({ index: index + 1, mode: input.mode, samples, rounds }));
    }
    const endStartedUnixMs = Date.now(); await new Promise(resolve => setTimeout(resolve, 5000));
    const finalMemory = await memory(pids), finalStorage = await storage(explorer.queries.directory);
    assert.deepEqual(await fs.readFile(input.module), disk); assert.equal(owner.getText(), original);
    const indexBeginsAfterReady = progressEvents.filter(value => value.kind === 'begin' && value.title !== 'Analyzing').length;
    assert.equal(errors.length, 0, JSON.stringify(errors)); assert.equal(indexBeginsAfterReady, 0, JSON.stringify(progressEvents));
    assert.equal(clientState(explorer).languageStates, 0); assert.equal(clientState(explorer).languageViews, 0);
    await fs.writeFile(path.join(fixture.root, 'host-result.json'), JSON.stringify({ passed: true, suite: 'query-performance', input, locale: vscode.env.language,
      vscode: vscode.version, node: process.version, metadataReadyMs, languageReadyMs, samples, initialMemory, initialStorage, finalMemory, finalStorage, rounds,
      pids, rpc, endStartedUnixMs, client: clientState(explorer), singleAnalyzerProcess: true, indexBusyDuringOperations: false, progressEvents, indexBeginsAfterReady, sourceDiskUnchanged: true, errors }));
  } catch (error) { await fs.writeFile(path.join(fixture.root, 'host-result.json'), JSON.stringify({ passed: false, suite: 'query-performance', error: String(error.stack ?? error), errors, samples, rounds, rpc })); throw error; }
  finally { if (watchdog) clearInterval(watchdog); }
};
