const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const path=require('node:path');
const vscode=require('vscode');
const {until,replace,parentTabs,returned,dirtyOpening}=require('./query-modal-host.cjs');

/** Real normal windows show native save prompts; a test/development host cannot validate those decisions. */
exports.run=async function(){
  const fixture=JSON.parse(process.env.ESKA_HOST_FIXTURE),accepted=[];
  try{
    assert.equal(await vscode.extensions.all.find(value=>value.packageJSON.name==='eska-explorer').activate(),undefined);
    await vscode.commands.executeCommand('eska.explorer.restart');
    await vscode.workspace.getConfiguration('window').update('dialogStyle','custom',vscode.ConfigurationTarget.Global);
    const uri=vscode.Uri.file(fixture.module),disk=await fs.readFile(fixture.module);
    let owner=await vscode.workspace.openTextDocument(uri);
    await vscode.window.showTextDocument(owner,{preview:false});await replace(owner,'Other = 42','Other = 43');
    await dirtyOpening(uri,'^Cancel$|^Отмена$');
    assert.equal(owner.isDirty,true);assert.equal(vscode.window.activeTextEditor.document.uri.toString(),uri.toString());
    assert.deepEqual(await fs.readFile(fixture.module),disk);
    assert.ok(!vscode.window.tabGroups.all.some(group=>group.tabs.some(tab=>tab.input instanceof vscode.TabInputText&&tab.input.uri.scheme==='eska-query')));
    accepted.push('native_cancel_preserves_dirty_parent_without_opening_child');
    await dirtyOpening(uri,'^Save$|^Сохранить$');
    await until(()=>vscode.window.activeTextEditor?.document.uri.scheme==='eska-query','explicit native Save opens child');
    assert.equal(parentTabs(uri).length,0);
    assert.equal((await fs.readFile(fixture.module)).toString('utf8').includes('Other = 43'),true);
    await vscode.commands.executeCommand('eska.explorer.cancelQuery');owner=await returned(uri);
    assert.equal(owner.isDirty,false);assert.ok(owner.getText().includes('Other = 43'));
    accepted.push('explicit_native_save_precedes_source_capture_and_return');
    await replace(owner,'Other = 43','Other = 44');
    await dirtyOpening(uri,"^Don't Save$|^Не сохранять$");
    await until(()=>vscode.window.activeTextEditor?.document.uri.scheme==='eska-query','explicit native discard opens child');
    await vscode.commands.executeCommand('eska.explorer.cancelQuery');owner=await returned(uri);
    assert.ok(owner.getText().includes('Other = 43'));assert.equal(owner.isDirty,false);
    accepted.push('only_explicit_native_discard_can_revert_unsaved_parent');
    await vscode.commands.executeCommand('workbench.action.files.setActiveEditorReadonlyInSession');
    const editor=vscode.window.activeTextEditor,at=owner.positionAt(owner.getText().indexOf('SELECT ')+3);editor.selection=new vscode.Selection(at,at);
    await vscode.commands.executeCommand('eska.explorer.editBslQuery');
    await until(()=>vscode.window.activeTextEditor?.document.uri.scheme==='eska-query','readonly parent child');
    await vscode.commands.executeCommand('eska.explorer.cancelQuery');owner=await returned(uri);
    const before=owner.getText();await vscode.commands.executeCommand('type',{text:'must not alter parent'});assert.equal(owner.getText(),before);
    await vscode.commands.executeCommand('workbench.action.files.resetActiveEditorReadonlyInSession');
    accepted.push('native_readonly_override_survives_modal_roundtrip');
    await fs.writeFile(path.join(fixture.root,'host-result.json'),JSON.stringify({passed:true,suite:'query-modal-normal',locale:vscode.env.language,accepted}));
  }catch(error){
    const logs=[];
    try{
      const root=path.join(path.dirname(fixture.root),'profile','logs');
      for(const file of (await fs.readdir(root,{recursive:true})).filter(file=>file.endsWith('ESKA Explorer.log'))){
        logs.push((await fs.readFile(path.join(root,file),'utf8')).slice(-7000));
      }
    }catch{}
    const editor=vscode.window.activeTextEditor;
    await fs.writeFile(path.join(fixture.root,'host-result.json'),JSON.stringify({passed:false,suite:'query-modal-normal',error:String(error.stack??error),accepted,
      active:editor&&{uri:editor.document.uri.toString(),dirty:editor.document.isDirty,version:editor.document.version,text:editor.document.getText().slice(0,500)},logs}));throw error;
  }
};
