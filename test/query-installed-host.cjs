const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const vscode = require('vscode');
const { connect, connectWorkbench } = require('./query-constructor-dom.cjs');

/** Both empty results and a stalled native provider share the same bounded acceptance deadline. */
async function until(operation, label, timeout = 30000) {
  const deadline = Date.now() + timeout;
  let timer;
  const polling = async () => {
    while (Date.now() < deadline) { const value = await operation(); if (value) return value; await new Promise(resolve => setTimeout(resolve, 25)); }
    throw new Error(label);
  };
  try {
    return await Promise.race([polling(), new Promise((_resolve, reject) => { timer = setTimeout(() => reject(new Error(label)), timeout); })]);
  } finally { clearTimeout(timer); }
}

/** Exercise the packaged runtime in a normal window, driving constructor actions through actual DOM buttons. */
exports.run = async function () {
  const fixture = JSON.parse(process.env.ESKA_HOST_FIXTURE), input = JSON.parse(await fs.readFile(process.env.ESKA_QUERY_PERF_INPUT, 'utf8'));
  let client, workbench;
  try {
    const extension = vscode.extensions.all.find(value => value.packageJSON.name === 'eska-explorer');
    assert.equal(await extension.activate(), undefined, 'normal mode does not export private acceptance APIs');
    assert.equal(vscode.env.language, process.env.ESKA_HOST_LOCALE);
    await vscode.commands.executeCommand('eska.explorer.restart');
    workbench = await connectWorkbench(until);
    await until(async () => /^ESKA v[0-9.]+$/.test(await workbench.evaluate('[...document.querySelectorAll(".statusbar-item")].find(node=>node.id.endsWith("eska.explorer.connection"))?.textContent.trim() ?? ""')),
      'workspace metadata connected', 60000);
    const disk = await fs.readFile(input.module);
    let owner = await vscode.workspace.openTextDocument(vscode.Uri.file(input.module));
    const original = owner.getText();
    const editor = await vscode.window.showTextDocument(owner, { preview: false }), point = owner.positionAt(owner.getText().indexOf('SELECT ') + 3);
    editor.selection = new vscode.Selection(point, point); await vscode.commands.executeCommand('eska.explorer.editBslQuery');
    const draft = await until(() => vscode.window.activeTextEditor?.document.uri.scheme === 'eska-query' && vscode.window.activeTextEditor.document, 'public query command');
    assert.ok(!vscode.window.tabGroups.all.some(group => group.tabs.some(tab => tab.input instanceof vscode.TabInputText
      && ['file','eska-protected'].includes(tab.input.uri.scheme) && tab.input.uri.path === owner.uri.path)), 'query replaces all parent aliases');
    await until(async () => {
      const at = draft.getText().indexOf(input.prefixA), result = await vscode.commands.executeCommand('vscode.executeCompletionItemProvider', draft.uri, draft.positionAt(at + input.prefixA.length));
      return result?.items.some(item => (typeof item.label === 'string' ? item.label : item.label.label) === input.labelA);
    }, 'published analyzer metadata completion');
    await vscode.commands.executeCommand('eska.explorer.queryConstructor', draft.uri); client = await connect(until);
    assert.deepEqual(await client.evaluate('[...document.querySelectorAll("[role=tab]")].map(tab=>tab.id)'),
      ['tab-tablesFields', 'tab-joins', 'tab-group', 'tab-conditions', 'tab-order', 'tab-unions', 'tab-totals', 'tab-packages', 'tab-dcs']);
    await client.evaluate(`document.querySelector('[data-section="fields"] .action-add').click()`);
    await client.evaluate(`for (const [key,value] of [["expression","99"],["alias","InstalledField"]]) { const input=document.querySelector('.expression [name="'+key+'"]'); input.value=value; input.dispatchEvent(new Event("input",{bubbles:true})); } document.querySelector(".expression").requestSubmit();`);
    await until(() => client.evaluate(`document.querySelector('[data-section="fields"]').textContent.includes("99 AS InstalledField")`), 'DOM accepted expression');
    await client.evaluate('document.querySelector("header button").click()'); client.close(); client = undefined;
    const changed = await until(() => {
      const document = vscode.window.activeTextEditor?.document;
      return document?.uri.scheme === 'eska-query' && document.getText().includes('99 AS InstalledField')
        && !vscode.window.tabGroups.all.some(group => group.tabs.some(tab => tab.input instanceof vscode.TabInputWebview && tab.input.viewType.includes('eska.queryConstructor')))
        && document;
    }, 'same draft acknowledged and returned');
    assert.equal(changed.uri.toString(), draft.uri.toString()); assert.ok(changed.getText().includes('99 AS InstalledField'));
    await vscode.commands.executeCommand('eska.explorer.applyQuery', changed.uri);
    owner = await vscode.workspace.openTextDocument(vscode.Uri.file(input.module));
    assert.equal(vscode.window.activeTextEditor?.document.uri.toString(), owner.uri.toString(), 'Apply returns the parent');
    assert.ok(owner.getText().includes('99 AS InstalledField')); assert.equal(owner.isDirty, true); assert.deepEqual(await fs.readFile(input.module), disk);
    await vscode.window.showTextDocument(owner); await vscode.commands.executeCommand('undo'); assert.equal(owner.getText(), original);
    await fs.writeFile(path.join(fixture.root, 'host-result.json'), JSON.stringify({ passed: true, suite: 'query-installed-normal', locale: vscode.env.language,
      runtime: extension.extensionPath, privateApiExported: false, actualDomActions: true, analyzerMetadataCompletion: true,
      sameDraft: true, singleQueryView: true, parentReturned: true, unsavedModuleSingleUndo: true, diskUnchanged: true }));
  } catch (error) {
    const ui = await workbench?.evaluate('({status:[...document.querySelectorAll(".statusbar-item")].filter(node=>/eska/i.test(node.id)).map(node=>node.textContent),notifications:[...document.querySelectorAll(".notification-message")].map(node=>node.textContent)})').catch(() => undefined);
    await fs.writeFile(path.join(fixture.root, 'host-result.json'), JSON.stringify({ passed: false, suite: 'query-installed-normal', error: String(error.stack ?? error),
      active: vscode.window.activeTextEditor?.document.uri.toString(), selection: vscode.window.activeTextEditor?.selection, ui })); throw error;
  }
  finally { client?.close(); workbench?.close(); }
};
