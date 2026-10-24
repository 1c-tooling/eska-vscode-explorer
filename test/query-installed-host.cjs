const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const vscode = require('vscode');
const { connect } = require('./query-constructor-dom.cjs');

/** Normal installed extensions expose commands, without the test-only Explorer object. */
async function until(operation, label) {
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) { const value = await operation(); if (value) return value; await new Promise(resolve => setTimeout(resolve, 25)); }
  throw new Error(label);
}

/** Exercise the packaged runtime in a normal window, driving constructor actions through actual DOM buttons. */
exports.run = async function () {
  const fixture = JSON.parse(process.env.ESKA_HOST_FIXTURE), input = JSON.parse(await fs.readFile(process.env.ESKA_QUERY_PERF_INPUT, 'utf8'));
  let client;
  try {
    const extension = vscode.extensions.all.find(value => value.packageJSON.name === 'eska-explorer');
    assert.equal(await extension.activate(), undefined, 'normal mode does not export private acceptance APIs');
    assert.equal(vscode.env.language, process.env.ESKA_HOST_LOCALE);
    const disk = await fs.readFile(input.module), owner = await vscode.workspace.openTextDocument(vscode.Uri.file(input.module)), original = owner.getText();
    const editor = await vscode.window.showTextDocument(owner, { preview: false }), point = owner.positionAt(owner.getText().indexOf('SELECT ') + 3);
    editor.selection = new vscode.Selection(point, point); await vscode.commands.executeCommand('eska.explorer.editBslQuery');
    const draft = await until(() => vscode.window.activeTextEditor?.document.uri.scheme === 'eska-query' && vscode.window.activeTextEditor.document, 'public query command');
    await until(async () => {
      const at = draft.getText().indexOf(input.prefixA), result = await vscode.commands.executeCommand('vscode.executeCompletionItemProvider', draft.uri, draft.positionAt(at + input.prefixA.length));
      return result?.items.some(item => (typeof item.label === 'string' ? item.label : item.label.label) === input.labelA);
    }, 'published analyzer metadata completion');
    await vscode.commands.executeCommand('eska.explorer.queryConstructor', draft.uri); client = await connect(until);
    assert.equal(await client.evaluate('document.querySelectorAll(".sections > section").length'), 6);
    await client.evaluate('document.querySelector(".sections > section .section-title button").click()');
    await client.evaluate('document.querySelector("textarea").value="99 AS InstalledField"; document.querySelector(".expression button").click()');
    await until(() => client.evaluate('document.querySelector(".sections > section").textContent.includes("99 AS InstalledField")'), 'DOM accepted expression');
    await client.evaluate('document.querySelector("header button").click()'); client.close(); client = undefined;
    const changed = await until(() => {
      const document = vscode.window.activeTextEditor?.document;
      return document?.uri.scheme === 'eska-query' && document.getText().includes('99 AS InstalledField')
        && !vscode.window.tabGroups.all.some(group => group.tabs.some(tab => tab.input instanceof vscode.TabInputWebview && tab.input.viewType.includes('eska.queryConstructor')))
        && document;
    }, 'same draft acknowledged and returned');
    assert.equal(changed.uri.toString(), draft.uri.toString()); assert.ok(changed.getText().includes('99 AS InstalledField'));
    await vscode.commands.executeCommand('eska.explorer.applyQuery', changed.uri);
    assert.ok(owner.getText().includes('99 AS InstalledField')); assert.equal(owner.isDirty, true); assert.deepEqual(await fs.readFile(input.module), disk);
    await vscode.window.showTextDocument(owner); await vscode.commands.executeCommand('undo'); assert.equal(owner.getText(), original);
    await fs.writeFile(path.join(fixture.root, 'host-result.json'), JSON.stringify({ passed: true, suite: 'query-installed-normal', locale: vscode.env.language,
      runtime: extension.extensionPath, privateApiExported: false, actualDomActions: true, analyzerMetadataCompletion: true,
      sameDraft: true, unsavedModuleSingleUndo: true, diskUnchanged: true }));
  } catch (error) { await fs.writeFile(path.join(fixture.root, 'host-result.json'), JSON.stringify({ passed: false, suite: 'query-installed-normal', error: String(error.stack ?? error) })); throw error; }
  finally { client?.close(); }
};
