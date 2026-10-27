const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const vscode = require('vscode');

/** Native UI state changes use bounded predicates rather than a fixed startup delay. */
async function until(action, label) {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) { if (await action()) return; await new Promise(resolve => setTimeout(resolve, 35)); }
  throw new Error(label);
}

/** One native transaction preserves the surrounding text and establishes a real undo boundary. */
async function replace(document, text) {
  const editor = await vscode.window.showTextDocument(document, { preview: false });
  assert.equal(await editor.edit(edit => edit.replace(new vscode.Range(document.positionAt(0), document.positionAt(document.getText().length)), text)), true);
}

/** Standard formatting commands exercise the installed provider and the editor's actual Undo/Redo stack. */
exports.run = async function () {
  const fixture = JSON.parse(process.env.ESKA_HOST_FIXTURE), accepted = [], timings = [];
  let explorer;
  try {
    const extension = vscode.extensions.getExtension('1c-tooling.eska-explorer'); assert.ok(extension);
    explorer = await extension.activate();
    await vscode.commands.executeCommand('eska.explorer.connect');
    await until(() => explorer.connection.state.kind === 'ready', 'metadata connection');
    const config = vscode.workspace.getConfiguration('eska.explorer');
    assert.equal(config.get('languageFeatures'), false); assert.equal(config.get('formatOnSave'), false);
    await vscode.workspace.getConfiguration('editor', { languageId: 'bsl' }).update('defaultFormatter', '1c-tooling.eska-explorer', vscode.ConfigurationTarget.Workspace);
    await vscode.workspace.getConfiguration('editor', { languageId: 'sdbl' }).update('defaultFormatter', '1c-tooling.eska-explorer', vscode.ConfigurationTarget.Workspace);
    let owner = await vscode.workspace.openTextDocument(vscode.Uri.file(fixture.module));
    const disk = await fs.readFile(fixture.module), original = owner.getText();
    await vscode.window.showTextDocument(owner, { preview: false });
    for (const attempt of ['cold', 'repeat']) {
      if (owner.getText() !== original) await vscode.commands.executeCommand('undo');
      const start = performance.now(); await vscode.commands.executeCommand('editor.action.formatDocument');
      timings.push({ attempt, milliseconds: performance.now() - start });
      assert.ok(owner.getText().includes('\tЗначение = 1;'));
      assert.ok(owner.getText().includes('"выбрать 1 как А,2 как Б"'), 'ordinary BSL formatting preserves literal SQL');
    }
    const formatted = owner.getText();
    await vscode.commands.executeCommand('undo'); assert.equal(owner.getText(), original);
    await vscode.commands.executeCommand('redo'); assert.equal(owner.getText(), formatted);
    assert.deepEqual(await fs.readFile(fixture.module), disk);
    accepted.push('document_format_native_undo_redo_and_dirty_buffer_without_disk_write');
    await vscode.commands.executeCommand('undo');
    const editor = vscode.window.activeTextEditor, start = owner.getText().indexOf('Значение=');
    editor.selection = new vscode.Selection(owner.positionAt(start), owner.positionAt(start + 'Значение=1;'.length));
    await vscode.commands.executeCommand('editor.action.formatSelection');
    assert.ok(owner.getText().includes('\tЗначение = 1;')); assert.ok(owner.getText().includes('Текст="выбрать 1 как А,2 как Б";'));
    accepted.push('selection_formats_only_expanded_syntax_unit');
    await vscode.commands.executeCommand('undo');
    const at = owner.positionAt(owner.getText().indexOf('выбрать') + 2); editor.selection = new vscode.Selection(at, at);
    await vscode.commands.executeCommand('eska.explorer.editBslQuery');
    await until(() => vscode.window.activeTextEditor?.document.uri.scheme === 'eska-query', 'private query draft');
    let draft = vscode.window.activeTextEditor.document;
    const queryOriginal = draft.getText();
    await vscode.commands.executeCommand('editor.action.formatDocument');
    const queryFormatted = draft.getText(); assert.notEqual(queryFormatted, queryOriginal); assert.ok(queryFormatted.startsWith('ВЫБРАТЬ'));
    await vscode.commands.executeCommand('undo'); assert.equal(draft.getText(), queryOriginal);
    await vscode.commands.executeCommand('redo'); assert.equal(draft.getText(), queryFormatted);
    owner = await vscode.workspace.openTextDocument(vscode.Uri.file(fixture.module));
    assert.equal(owner.getText(), original); assert.deepEqual(await fs.readFile(fixture.module), disk);
    accepted.push('query_format_acknowledged_draft_and_native_undo_redo_without_owner_write');
    // The parent lease is visible to the separate, metadata-free formatter process.
    const rejected = await vscode.commands.executeCommand('vscode.executeFormatDocumentProvider', owner.uri, { tabSize: 4, insertSpaces: false });
    assert.equal(rejected?.length ?? 0, 0);
    accepted.push('active_query_rejects_parent_format_from_another_process');
    // CRLF belongs to the native editor; ESKA matches its LF checkpoint without changing UTF-8 plan coordinates.
    await vscode.window.showTextDocument(draft, { preview: false });
    await replace(draft, 'выбрать\n1 как А,2 как Б');
    const queryEditor = vscode.window.activeTextEditor;
    assert.equal(await queryEditor.edit(edit => edit.setEndOfLine(vscode.EndOfLine.CRLF)), true);
    await vscode.commands.executeCommand('editor.action.formatDocument');
    assert.ok(draft.getText().startsWith('ВЫБРАТЬ\r\n')); assert.equal(draft.eol, vscode.EndOfLine.CRLF);
    accepted.push('query_crlf_snapshot_matches_acknowledged_lf_checkpoint');
    explorer.queries.closeDecision = async () => 'discard';
    await vscode.window.tabGroups.close(vscode.window.tabGroups.activeTabGroup.activeTab);
    await until(() => !explorer.queries.sessions.size, 'query closes and releases owner');
    owner = await vscode.workspace.openTextDocument(vscode.Uri.file(fixture.module));
    await vscode.window.showTextDocument(owner, { preview: false });
    await config.update('formatOnSave', true, vscode.ConfigurationTarget.Workspace);
    await replace(owner, original.replace('Значение=1', 'Значение=3'));
    assert.equal(await owner.save(), true);
    assert.ok(owner.getText().includes('\tЗначение = 3;'));
    const saved = await fs.readFile(fixture.module);
    assert.equal(saved[0], 0xef); assert.equal(saved[1], 0xbb); assert.equal(saved[2], 0xbf);
    assert.ok(saved.toString('utf8').includes('\r\n')); assert.equal(saved.toString('utf8').replace(/^\ufeff/, ''), owner.getText());
    accepted.push('opt_in_save_formats_and_preserves_bom_crlf');
    await config.update('formatOnSave', false, vscode.ConfigurationTarget.Workspace);
    await explorer.formatting.stop();
    const repeat = await vscode.commands.executeCommand('vscode.executeFormatDocumentProvider', owner.uri, { tabSize: 9, insertSpaces: true });
    assert.equal(repeat?.length ?? 0, 0); accepted.push('restarted_formatter_is_idempotent_and_ignores_native_indent_preferences');
    await fs.writeFile(path.join(fixture.root, 'host-result.json'), JSON.stringify({ passed: true, suite: 'formatting', locale: vscode.env.language, accepted, timings }));
  } catch (error) {
    await fs.writeFile(path.join(fixture.root, 'host-result.json'), JSON.stringify({ passed: false, suite: 'formatting', accepted, timings, error: String(error.stack ?? error) })); throw error;
  } finally { await explorer?.shutdown(); }
};
