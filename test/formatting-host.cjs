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
    assert.equal(config.get('languageFeatures'), process.env.ESKA_TEST_LANGUAGE === '1'); assert.equal(config.get('formatOnSave'), false);
    await vscode.workspace.getConfiguration('editor', { languageId: 'bsl' }).update('defaultFormatter', '1c-tooling.eska-explorer', vscode.ConfigurationTarget.Workspace);
    await vscode.workspace.getConfiguration('editor', { languageId: 'sdbl' }).update('defaultFormatter', '1c-tooling.eska-explorer', vscode.ConfigurationTarget.Workspace);
    let owner = await vscode.workspace.openTextDocument(vscode.Uri.file(fixture.module));
    const disk = await fs.readFile(fixture.module), original = owner.getText();
    if (process.env.ESKA_HOST_RUN === '1') {
      assert.ok(original.includes('\tЗначение = 3;'));
      const edits = await vscode.commands.executeCommand('vscode.executeFormatDocumentProvider', owner.uri, { tabSize: 17, insertSpaces: true });
      assert.equal(edits?.length ?? 0, 0);
      assert.deepEqual(await fs.readFile(fixture.module), disk);
      await fs.writeFile(path.join(fixture.root, 'host-result.json'), JSON.stringify({ passed: true, suite: 'formatting-restart', locale: vscode.env.language,
        accepted: [`${process.env.ESKA_TEST_VSIX ? 'installed_vsix' : 'development_extension'}_restarted_and_saved_source_remains_idempotent`], formatter: explorer.tooling.states.formatter.info }));
      return;
    }

    await vscode.window.showTextDocument(owner, { preview: false });
    for (const attempt of ['cold', 'repeat']) {
      if (owner.getText() !== original) await vscode.commands.executeCommand('undo');
      const start = performance.now(); await vscode.commands.executeCommand('editor.action.formatDocument');
      timings.push({ attempt, milliseconds: performance.now() - start });
      assert.ok(owner.getText().includes('\tЗначение = 1;'));
      assert.ok(owner.getText().includes('"выбрать 1 как А,2 как Б"'), 'ordinary BSL formatting preserves literal SQL');
    }
    if (process.env.ESKA_TEST_LANGUAGE === '1') {
      await until(() => explorer.tooling.states.analyzer.phase === 'ready', 'independent analyzer session');
      const position = owner.positionAt(owner.getText().indexOf('Значение') + 2);
      const hovers = await vscode.commands.executeCommand('vscode.executeHoverProvider', owner.uri, position);
      assert.ok(hovers?.length, 'analyzer hover remains available alongside eska-fmt');
      accepted.push('full_set_keeps_independent_analyzer_hover_and_single_eska_formatter');
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
    await replace(owner, 'А=1;   ');
    const tailRange = new vscode.Range(owner.positionAt(4), owner.positionAt(7));
    const tailEdits = await vscode.commands.executeCommand('vscode.executeFormatRangeProvider', owner.uri, tailRange, { tabSize: 4, insertSpaces: false });
    assert.ok(tailEdits?.length, 'EOF trivia has a valid native edit');
    assert.equal(await vscode.window.activeTextEditor.edit(edit => {
      for (const replacement of tailEdits) edit.replace(replacement.range, replacement.newText);
    }), true);
    assert.equal(owner.getText(), 'А=1;\r\n');
    await replace(owner, original);
    accepted.push('trailing_whitespace_selection_preserves_unselected_bsl_and_returns_valid_coordinates');
    const formatterPath = config.get('formatterExecutable');
    await config.update('formatterExecutable', config.get('executable'), vscode.ConfigurationTarget.Workspace);
    const rejectedComponent = await vscode.commands.executeCommand('vscode.executeFormatDocumentProvider', owner.uri, { tabSize: 4, insertSpaces: false });
    assert.equal(rejectedComponent?.length ?? 0, 0); assert.equal(owner.getText(), original);
    await config.update('formatterExecutable', formatterPath, vscode.ConfigurationTarget.Workspace);
    accepted.push('incompatible_formatter_identity_rejected_before_edits_without_analyzer_fallback');
    const changing = vscode.commands.executeCommand('vscode.executeFormatDocumentProvider', owner.uri, { tabSize: 4, insertSpaces: false });
    await until(() => explorer.formatting.requests.has(owner), 'native formatting request starts');
    await replace(owner, original.replace('Значение=1', 'Значение=8'));
    await changing; assert.ok(owner.getText().includes('Значение=8;'));
    await vscode.commands.executeCommand('undo'); assert.equal(owner.getText(), original);
    accepted.push('native_edit_cancels_obsolete_formatter_reply');
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
    await config.update('formatOnSave', true, vscode.ConfigurationTarget.Workspace);
    await replace(draft, 'выбрать 3 как А,4 как Б');
    assert.equal(await draft.save(), true);
    assert.ok(draft.getText().startsWith('ВЫБРАТЬ'));
    assert.deepEqual(await fs.readFile(fixture.module), disk);
    await config.update('formatOnSave', false, vscode.ConfigurationTarget.Workspace);
    accepted.push('query_format_on_save_only_checkpoints_private_bsl_draft');

    explorer.queries.closeDecision = async () => 'discard';
    await vscode.window.tabGroups.close(vscode.window.tabGroups.activeTabGroup.activeTab);
    await until(() => !explorer.queries.sessions.size, 'query closes and releases owner');
    owner = await vscode.workspace.openTextDocument(vscode.Uri.file(fixture.module));
    await vscode.window.showTextDocument(owner, { preview: false });
    const controlled = '&ChangeAndValidate("Run")\r\nProcedure Custom()\r\n   A=1; // original  \r\n#Insert\r\nB= 2;\r\n#EndInsert\r\nEndProcedure';
    await replace(owner, `X=1;\r\n${controlled}\r\n\r\nProcedure Other()\r\nC=3;\r\nEndProcedure\r\n`);
    await vscode.commands.executeCommand('editor.action.formatDocument');
    assert.ok(owner.getText().includes(controlled)); assert.ok(owner.getText().includes('\tC = 3;'));
    await replace(owner, original);
    accepted.push('controlled_method_remains_byte_identical_while_ordinary_code_formats');
    await protectedSelection(fixture.root, accepted);
    await vscode.window.showTextDocument(owner, { preview: false });
    await config.update('formatOnSave', true, vscode.ConfigurationTarget.Workspace);
    await vscode.workspace.getConfiguration('editor').update('formatOnSave', true, vscode.ConfigurationTarget.Workspace);
    await vscode.workspace.getConfiguration('editor', owner).update('formatOnSave', false, vscode.ConfigurationTarget.Workspace, true);
    assert.equal(vscode.workspace.getConfiguration('editor', owner).get('formatOnSave'), false);
    await replace(owner, original.replace('Значение=1', 'Значение=3'));
    assert.equal(await owner.save(), true);
    assert.ok(owner.getText().includes('\tЗначение = 3;'));
    const saved = await fs.readFile(fixture.module);
    assert.equal(saved[0], 0xef); assert.equal(saved[1], 0xbb); assert.equal(saved[2], 0xbf);
    assert.ok(saved.toString('utf8').includes('\r\n')); assert.equal(saved.toString('utf8').replace(/^\ufeff/, ''), owner.getText());
    accepted.push('opt_in_save_formats_and_preserves_bom_crlf');
    accepted.push('eska_save_opt_in_respects_language_specific_native_format_on_save');
    await vscode.workspace.getConfiguration('editor', owner).update('formatOnSave', undefined, vscode.ConfigurationTarget.Workspace, true);
    await vscode.workspace.getConfiguration('editor').update('formatOnSave', false, vscode.ConfigurationTarget.Workspace);
    await config.update('formatOnSave', false, vscode.ConfigurationTarget.Workspace);
    await explorer.formatting.stop();
    const repeat = await vscode.commands.executeCommand('vscode.executeFormatDocumentProvider', owner.uri, { tabSize: 9, insertSpaces: true });
    assert.equal(repeat?.length ?? 0, 0); accepted.push('restarted_formatter_is_idempotent_and_ignores_native_indent_preferences');
    await fs.writeFile(path.join(fixture.root, 'host-result.json'), JSON.stringify({ passed: true, suite: 'formatting', locale: vscode.env.language, accepted, timings }));
  } catch (error) {
    await fs.writeFile(path.join(fixture.root, 'host-result.json'), JSON.stringify({ passed: false, suite: 'formatting', accepted, timings, error: String(error.stack ?? error) })); throw error;
  } finally { await explorer?.shutdown(); }
};

/** Exercise actual core supplier checks through native document/range providers in a separate owned project. */
async function protectedSelection(root, accepted) {
  const project = path.join(root, 'fmt-protection'), ext = path.join(project, 'src', 'Ext');
  await fs.mkdir(ext, { recursive: true });
  const uuid = '11111111-1111-1111-1111-111111111111';
  await fs.writeFile(path.join(project, 'eska.toml'), "[project]\ntype='configuration'\n");
  await fs.writeFile(path.join(project, 'src', 'Configuration.xml'), `<MetaDataObject xmlns="http://v8.1c.ru/8.3/MDClasses"><Configuration uuid="${uuid}"><Properties><Name>FmtProtection</Name></Properties><ChildObjects/></Configuration></MetaDataObject>`);
  const rules = rule => `{6,0,1,${uuid},0,${uuid},"1","Vendor","Demo",1,${rule},0,${uuid},${uuid},0,0,${Array(13).fill('0').join(',')}}`;
  const policy = path.join(ext, 'ParentConfigurations.bin'), source = path.join(ext, 'ManagedApplicationModule.bsl');
  const text = 'Procedure Run()\n    A=1;\n    B=2;\nEndProcedure\n';
  await fs.writeFile(policy, rules(1)); await fs.writeFile(source, text);
  const document = await vscode.workspace.openTextDocument(source);
  const editor = await vscode.window.showTextDocument(document, { preview: false });
  const options = { tabSize: 4, insertSpaces: false };
  assert.equal((await vscode.commands.executeCommand('vscode.executeFormatDocumentProvider', document.uri, options))?.length ?? 0, 0);
  const line = text.indexOf('    A=1;');
  const partial = new vscode.Range(document.positionAt(line + 4), document.positionAt(line + 5));
  assert.equal((await vscode.commands.executeCommand('vscode.executeFormatRangeProvider', document.uri, partial, options))?.length ?? 0, 0);
  const selected = new vscode.Range(document.positionAt(line), document.positionAt(line + '    A=1;'.length));
  const edits = await vscode.commands.executeCommand('vscode.executeFormatRangeProvider', document.uri, selected, options);
  assert.ok(edits?.length);
  assert.equal(await editor.edit(builder => { for (const edit of edits) builder.replace(edit.range, edit.newText); }), true);
  assert.equal(document.getText(), text.replace('    A=1;', '\tA = 1;'));
  assert.equal(await fs.readFile(source, 'utf8'), text);
  await vscode.commands.executeCommand('undo'); assert.equal(document.getText(), text);
  accepted.push('supported_file_rejects_whole_document_and_expansion_but_accepts_exact_selection_with_native_undo');
  await fs.writeFile(policy, rules(0));
  assert.equal((await vscode.commands.executeCommand('vscode.executeFormatRangeProvider', document.uri, selected, options))?.length ?? 0, 0);
  assert.equal(document.getText(), text); assert.equal(await fs.readFile(source, 'utf8'), text);
  accepted.push('locked_supplier_file_rejects_selection_without_source_changes');
}
