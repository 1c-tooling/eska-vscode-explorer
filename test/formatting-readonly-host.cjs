const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const vscode = require('vscode');

/** Wait only for this isolated editor's actual metadata connection. */
async function until(predicate, label = 'metadata connection timeout') {
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) { if (predicate()) return; await new Promise(resolve => setTimeout(resolve, 40)); }
  throw new Error(label);
}

/** Reproduce a global BSL readonly default with the user's native per-session writable override. */
exports.run = async function () {
  const fixture = JSON.parse(process.env.ESKA_HOST_FIXTURE), accepted = [];
  let explorer;
  try {
    const source = await fs.readFile(fixture.module, 'utf8');
    const extension = vscode.extensions.getExtension('1c-tooling.eska-explorer');
    explorer = await extension.activate();
    await vscode.commands.executeCommand('eska.explorer.connect');
    await until(() => explorer.connection.state.kind === 'ready');
    await vscode.workspace.getConfiguration('editor', { languageId: 'bsl' }).update('defaultFormatter', '1c-tooling.eska-explorer', vscode.ConfigurationTarget.Workspace);
    const settings = vscode.workspace.getConfiguration('files');
    await settings.update('readonlyInclude', { '**/*.bsl': true }, vscode.ConfigurationTarget.Workspace);
    const document = await vscode.workspace.openTextDocument(fixture.module);
    const editor = await vscode.window.showTextDocument(document, { preview: false });
    await vscode.commands.executeCommand('workbench.action.focusActiveEditorGroup');
    await vscode.commands.executeCommand('editor.action.formatDocument');
    assert.equal(document.getText(), source, 'native readonly editor does not apply formatting');
    accepted.push('editor_enforces_readonly_default_before_user_override');
    await vscode.commands.executeCommand('workbench.action.files.setActiveEditorWriteableInSession');
    const options = { tabSize: 4, insertSpaces: false };
    const full = await vscode.commands.executeCommand('vscode.executeFormatDocumentProvider', document.uri, options);
    assert.ok(full?.length, 'document provider honors the native writable override');
    assert.equal(await editor.edit(builder => { for (const edit of full) builder.replace(edit.range, edit.newText); }), true);
    await until(() => document.getText().includes('\tValue = 1;'), 'native writable document formatting');
    assert.ok(document.getText().includes('\tValue = 1;'), 'document formatting honors the native writable override');
    await vscode.commands.executeCommand('undo'); assert.equal(document.getText(), source);
    const start = source.indexOf('Value=1;');
    const selected = new vscode.Range(document.positionAt(start), document.positionAt(start + 'Value=1;'.length));
    editor.selection = new vscode.Selection(selected.start, selected.end);
    const partial = await vscode.commands.executeCommand('vscode.executeFormatRangeProvider', document.uri, selected, options);
    assert.ok(partial?.length, 'range provider honors the native writable override');
    assert.equal(await editor.edit(builder => { for (const edit of partial) builder.replace(edit.range, edit.newText); }), true);
    assert.ok(document.getText().includes('\tValue = 1;'), 'selection formatting honors the native writable override');
    assert.ok(document.getText().includes('\nOther=2;'), 'unselected statement remains unchanged');
    await vscode.commands.executeCommand('undo'); assert.equal(document.getText(), source);
    assert.deepEqual(vscode.workspace.getConfiguration('files', document).get('readonlyInclude'), { '**/*.bsl': true });
    assert.equal(await fs.readFile(fixture.module, 'utf8'), source);
    accepted.push('global_readonly_default_with_native_writable_override_supports_document_range_and_undo');
    const mode = (await fs.stat(fixture.module)).mode;
    await fs.chmod(fixture.module, mode & ~0o222);
    try {
      const edits = await vscode.commands.executeCommand('vscode.executeFormatDocumentProvider', document.uri, { tabSize: 4, insertSpaces: false });
      assert.equal(edits?.length ?? 0, 0, 'ESKA rejects physically readonly files after a native override');
      assert.equal(document.getText(), source);
    } finally { await fs.chmod(fixture.module, mode); }
    accepted.push('filesystem_readonly_cannot_be_bypassed_by_native_writable_override');
    await fs.writeFile(path.join(fixture.root, 'host-result.json'), JSON.stringify({ passed: true, suite: 'formatting-readonly', locale: vscode.env.language, accepted }));
  } catch (error) {
    await fs.writeFile(path.join(fixture.root, 'host-result.json'), JSON.stringify({ passed: false, suite: 'formatting-readonly', accepted, error: String(error.stack ?? error) })); throw error;
  } finally { await explorer?.shutdown(); }
};
