const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const vscode = require('vscode');

/** Observe native tab and focus acknowledgements, not an assumed event order. */
async function until(action, label) {
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) { const value = await action(); if (value) return value; await new Promise(resolve => setTimeout(resolve, 30)); }
  throw new Error(label);
}

/** All edits use native documents and their real undo history. */
async function replace(document, before, after) {
  const offset = document.getText().indexOf(before); assert.ok(offset >= 0, before);
  const edit = new vscode.WorkspaceEdit(); edit.replace(document.uri,
    new vscode.Range(document.positionAt(offset), document.positionAt(offset + before.length)), after);
  assert.equal(await vscode.workspace.applyEdit(edit), true);
}

/** Include protected aliases and split views of the same source. */
function parentTabs(uri) {
  return vscode.window.tabGroups.all.flatMap(group => group.tabs).filter(tab => tab.input instanceof vscode.TabInputText
    && ['file', 'eska-protected'].includes(tab.input.uri.scheme) && tab.input.uri.path === uri.path);
}

/** Public contextual editing must leave exactly one child and no parent views. */
async function openQuery(uri) {
  const owner = await vscode.workspace.openTextDocument(uri), editor = await vscode.window.showTextDocument(owner, {preview:false});
  const at = owner.positionAt(owner.getText().indexOf('SELECT ') + 3); editor.selection = new vscode.Selection(at, at);
  await vscode.commands.executeCommand('eska.explorer.editBslQuery');
  const draft = await until(() => vscode.window.activeTextEditor?.document.uri.scheme === 'eska-query'
    && vscode.window.activeTextEditor.document, 'child focus');
  assert.equal(parentTabs(uri).length, 0); return draft;
}

/** The original resource must be restored after every operation that completes the child. */
async function returned(uri) {
  await until(() => vscode.window.activeTextEditor?.document.uri.toString() === uri.toString(), 'returned to original parent');
  assert.equal(parentTabs(uri).length, 1);
  return vscode.window.activeTextEditor.document;
}

/** Query rows are resolved through the production tree, including the common metadata branch. */
async function firstXmlQuery(explorer, kind) {
  const [root]=await explorer.getChildren(), roots=await explorer.getChildren(root);
  const common=roots.find(row=>row.node?.id.collection?.kind==='common');
  const groups=[...roots,...await explorer.getChildren(common)];
  const group=groups.find(row=>row.node?.id.collection?.metadataKind===kind);assert.ok(group);
  const [owner]=await explorer.getChildren(group);
  const [branch]=(await explorer.getChildren(owner)).filter(row=>row.queryKind==='branch');assert.ok(branch);
  const [query]=await explorer.getChildren(branch);return query;
}

/** Click the real custom native confirmation in this test window's explicitly enabled Chromium endpoint. */
async function dialogButton(label) {
  const port = Number(process.env.ESKA_HOST_DEBUG_PORT); assert.ok(port > 0);
  const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  const target = targets.find(value => value.type === 'page' && value.url.includes('workbench'));
  assert.ok(target, 'native workbench target');
  const socket = new WebSocket(target.webSocketDebuggerUrl); let serial = 0; const pending = new Map();
  await new Promise((resolve, reject) => {socket.onopen=resolve; socket.onerror=reject;});
  socket.onmessage = event => {const value=JSON.parse(event.data); const done=pending.get(value.id); if(done){pending.delete(value.id); value.error?done.reject(new Error(JSON.stringify(value.error))):done.resolve(value.result);}};
  const evaluate = expression => new Promise((resolve,reject)=>{const id=++serial;pending.set(id,{resolve,reject});socket.send(JSON.stringify({id,method:'Runtime.evaluate',params:{expression,returnByValue:true}}));});
  try {
    await until(async () => {
      const result = await evaluate(`(()=>{const box=document.querySelector('.monaco-dialog-box');if(!box)return false;const button=[...box.querySelectorAll('button, .monaco-button')].find(value=>new RegExp(${JSON.stringify(label)},'i').test(value.textContent.replaceAll('&','')));if(!button)return false;button.click();return true})()`);
      return result.result.value === true;
    }, 'native dirty confirmation: '+label);
  } finally {socket.close();}
}

/** A real dirty close must wait for an explicit native decision before allocating any query session. */
async function dirtyOpening(uri, decision) {
  const owner = await vscode.workspace.openTextDocument(uri), editor = await vscode.window.showTextDocument(owner, {preview:false});
  const at=owner.positionAt(owner.getText().indexOf('SELECT ')+3);editor.selection=new vscode.Selection(at,at);
  const opening=vscode.commands.executeCommand('eska.explorer.editBslQuery');
  await dialogButton(decision); await opening;
}

/** Exercise modal replacement, all close paths, parent input blocking, nested constructor ownership and dirty confirmations. */
exports.run = async function () {
  const fixture=JSON.parse(process.env.ESKA_HOST_FIXTURE), accepted=[];
  let explorer;
  try {
    explorer=await vscode.extensions.all.find(value=>value.packageJSON.name==='eska-explorer').activate();
    await until(()=>explorer.tree&&explorer.connection.state.kind==='ready'&&!explorer.support.loading,'backend ready');
    const uri=vscode.Uri.file(fixture.module), disk=await fs.readFile(fixture.module), original=(await vscode.workspace.openTextDocument(uri)).getText();
    await vscode.window.showTextDocument(uri,{preview:false}); await vscode.commands.executeCommand('workbench.action.splitEditorRight');
    await vscode.window.showTextDocument(uri.with({scheme:'eska-protected'}),{preview:false});
    let draft=await openQuery(uri);
    accepted.push('one_query_replaces_file_protected_and_split_parents');
    await vscode.window.showTextDocument(uri,{preview:false});
    await until(()=>vscode.window.activeTextEditor?.document.uri.toString()===draft.uri.toString()&&parentTabs(uri).length===0,'parent navigation redirected');
    await vscode.commands.executeCommand('type',{text:' '});
    assert.equal((await vscode.workspace.openTextDocument(uri)).getText(),original);
    await vscode.commands.executeCommand('undo');
    accepted.push('parent_cannot_receive_interactive_typing');
    await explorer.queryDesigner.show(draft.uri);
    const view=[...explorer.queryDesigner.views.values()][0];assert.ok(view);
    await vscode.window.showTextDocument(draft.uri,{preview:false});
    await until(()=>view.panel.active&&!vscode.window.tabGroups.all.some(group=>group.tabs.some(tab=>tab.input instanceof vscode.TabInputText&&tab.input.uri.toString()===draft.uri.toString())),'constructor retains modality');
    assert.equal(view.binding.current,true);view.panel.dispose();
    draft=await until(()=>vscode.window.activeTextEditor?.document.uri.toString()===draft.uri.toString()&&vscode.window.activeTextEditor.document,'constructor returns query');
    assert.equal(parentTabs(uri).length,0);
    accepted.push('nested_constructor_blocks_query_parent_and_returns_same_draft');
    const queryBeforeReview=draft.getText();
    await explorer.queries.compare(draft.uri);
    const session=[...explorer.queries.sessions.values()][0],review=session.review;assert.ok(review?.current);
    assert.equal(vscode.window.tabGroups.all.flatMap(group=>group.tabs).filter(tab=>tab.input instanceof vscode.TabInputText&&tab.input.uri.toString()===draft.uri.toString()).length,0);
    await vscode.window.showTextDocument(draft.uri,{preview:false});
    await until(()=>vscode.window.activeTextEditor?.document.uri.toString()===review.current.toString(),'comparison retains modality');
    const compared=vscode.window.activeTextEditor.document,comparedText=compared.getText();
    await vscode.commands.executeCommand('type',{text:'must not edit parent'});assert.equal(draft.getText(),queryBeforeReview);assert.equal(compared.getText(),comparedText);
    const currentOwner=await vscode.workspace.openTextDocument(uri);await replace(currentOwner,'Other = 42','Other = 43');
    assert.ok(Buffer.from(await vscode.workspace.fs.readFile(review.snapshot)).toString().includes('Other = 42'));
    assert.ok(Buffer.from(await vscode.workspace.fs.readFile(review.current)).toString().includes('Other = 43'));
    await until(()=>vscode.workspace.textDocuments.find(value=>value.uri.toString()===review.current.toString())?.getText().includes('Other = 43'),'visible readonly comparison follows native owner facts');
    const reviewTabs=vscode.window.tabGroups.all.flatMap(group=>group.tabs).filter(tab=>tab.input instanceof vscode.TabInputTextDiff&&tab.input.original.toString()===review.snapshot.toString());
    assert.equal(await vscode.window.tabGroups.close(reviewTabs),true);
    draft=await until(()=>vscode.window.activeTextEditor?.document.uri.scheme==='eska-query'&&vscode.window.activeTextEditor.document.uri.path.endsWith('.sdbl')&&vscode.window.activeTextEditor.document,'review returns same query');
    assert.equal(draft.getText(),queryBeforeReview);assert.equal(parentTabs(uri).length,0);
    await vscode.commands.executeCommand('eska.explorer.applyQuery',draft.uri);
    assert.ok((await vscode.workspace.openTextDocument(uri)).getText().includes('Other = 43'));
    await vscode.commands.executeCommand('eska.explorer.cancelQuery',draft.uri);await returned(uri);
    await vscode.commands.executeCommand('undo');assert.equal((await vscode.workspace.openTextDocument(uri)).getText(),original);
    draft=await openQuery(uri);
    accepted.push('readonly_comparison_blocks_query_parent_and_preserves_external_owner_change');
    await replace(draft,'SELECT 1','SELECT 2');assert.equal(await draft.save(),true);
    assert.equal(parentTabs(uri).length,0);
    await vscode.commands.executeCommand('eska.explorer.applyQuery',draft.uri);
    let owner=await returned(uri);assert.equal(owner.getText(),original.replace('SELECT 1','SELECT 2'));assert.equal(owner.isDirty,true);
    assert.deepEqual(await fs.readFile(fixture.module),disk);
    await vscode.commands.executeCommand('undo');assert.equal(owner.getText(),original);
    accepted.push('apply_returns_unsaved_parent_with_single_undo');
    draft=await openQuery(uri);await replace(draft,'SELECT 1','SELECT 3');
    await vscode.commands.executeCommand('eska.explorer.cancelQuery',draft.uri);owner=await returned(uri);assert.equal(owner.getText(),original);
    accepted.push('explicit_cancel_returns_unchanged_parent');
    draft=await openQuery(uri);await vscode.window.tabGroups.close(vscode.window.tabGroups.all.flatMap(group=>group.tabs).filter(tab=>tab.input instanceof vscode.TabInputText&&tab.input.uri.toString()===draft.uri.toString()));
    await returned(uri);accepted.push('unchanged_tab_close_returns_parent');
    const decision=explorer.queries.closeDecision;
    try {
      for(const choice of ['keep','discard',undefined]) {
        explorer.queries.closeDecision=async()=>choice;
        draft=await openQuery(uri);await replace(draft,'SELECT 1','SELECT 4');await draft.save();
        await vscode.window.tabGroups.close(vscode.window.tabGroups.all.flatMap(group=>group.tabs).filter(tab=>tab.input instanceof vscode.TabInputText&&tab.input.uri.toString()===draft.uri.toString()));
        if(choice===undefined){await until(()=>vscode.window.activeTextEditor?.document.uri.toString()===draft.uri.toString(),'cancelled close retains child');await vscode.commands.executeCommand('eska.explorer.cancelQuery',draft.uri);}
        await returned(uri);
        if(choice==='keep'){draft=await openQuery(uri);await vscode.commands.executeCommand('eska.explorer.resumeQuery');await vscode.commands.executeCommand('eska.explorer.cancelQuery',draft.uri);await returned(uri);}
      }
    } finally {explorer.queries.closeDecision=decision;}
    accepted.push('keep_discard_and_cancelled_close_restore_correct_parent_or_child');
    for(const [kind,file] of [['common-template',fixture.query.schemaPath],['common-form',fixture.query.formPath]]){
      const xmlUri=vscode.Uri.file(file),before=await fs.readFile(file,'utf8');
      await vscode.window.showTextDocument(xmlUri,{preview:false});
      await vscode.commands.executeCommand('eska.explorer.openQuery',await firstXmlQuery(explorer,kind));
      draft=vscode.window.activeTextEditor.document;assert.equal(draft.uri.scheme,'eska-query');assert.equal(parentTabs(xmlUri).length,0);
      await replace(draft,'SELECT 1','SELECT 8');assert.equal(await draft.save(),true);
      const xml=await returned(xmlUri);assert.equal(xml.isDirty,false);
      const after=await fs.readFile(file,'utf8');assert.ok(after.includes('SELECT 8'));assert.ok(before.includes('SELECT 1'));
      assert.ok(after.includes(kind==='common-template'?'SELECT 2':'<QueryText>SELECT 2</QueryText>'));
    }
    accepted.push('scd_and_dynamic_list_save_return_xml_parent_and_preserve_other_query');
    assert.equal(explorer.queries.sessions.size,0);
    await fs.writeFile(path.join(fixture.root,'host-result.json'),JSON.stringify({passed:true,suite:'query-modal',locale:vscode.env.language,accepted}));
  } catch(error) {await fs.writeFile(path.join(fixture.root,'host-result.json'),JSON.stringify({passed:false,suite:'query-modal',error:String(error.stack??error),accepted,
    active:vscode.window.activeTextEditor?.document.uri.toString(),tabs:vscode.window.tabGroups.all.flatMap(group=>group.tabs).map(tab=>({label:tab.label,dirty:tab.isDirty,uri:tab.input?.uri?.toString()})),
    sessions:explorer&&[...explorer.queries.sessions.values()].map(session=>({parent:session.parent?.uri.toString(),active:session.parent?.active,guarding:!!session.guarding,ending:session.ending,closing:!!session.closing}))}));throw error;}
};

// The normal-window suite reuses the UI driver because extension-test windows deliberately bypass native save confirmations.
exports.until=until;exports.replace=replace;exports.parentTabs=parentTabs;exports.returned=returned;exports.dirtyOpening=dirtyOpening;
