const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const vscode = require('vscode');
const { connectWorkbench } = require('./query-constructor-dom.cjs');
let stage = 'bootstrap';

async function until(action, label, timeout=45000) {
  const deadline = Date.now() + timeout; let last;
  while (Date.now() < deadline) {
    try { const value = await action(); if (value) return value; } catch (error) { last = error; }
    await new Promise(done => setTimeout(done, 50));
  }
  throw new Error(label + (last ? `: ${last.stack ?? last}` : ''));
}
const phrases = ['Найдено кандидатов', 'Время выполнения', 'Кириллица', 'Своя строка', 'Её продолжение', 'Вложенный текст', 'Его продолжение', 'Одиночный текст','Первая цепочка','Конец первой','Начало второй','Конец второй'];
async function geometry(workbench) {
  return workbench.evaluate(`(() => {
    const phrases=${JSON.stringify(phrases)}, positions={};
    const root=[...document.querySelectorAll('.monaco-editor .view-lines')].find(node=>node.getBoundingClientRect().width>0&&node.getBoundingClientRect().height>0&&node.textContent.includes('Найдено'));
    if(!root)return {positions,attachments:[]};
    for(const line of root.querySelectorAll('.view-line')) {
      const nodes=[],walker=document.createTreeWalker(line,NodeFilter.SHOW_TEXT);let text='';
      for(let node=walker.nextNode();node;node=walker.nextNode()) {nodes.push({node,start:text.length});text+=node.textContent.replaceAll('\u00a0',' ');}
      for(const phrase of phrases){
        const start=text.indexOf(phrase);if(start<0||positions[phrase]!==undefined)continue;
        const part=nodes.find(value=>value.start<=start&&start<value.start+value.node.textContent.length);if(!part)continue;
        const range=document.createRange();range.setStart(part.node,start-part.start);range.setEnd(part.node,start-part.start+1);positions[phrase]=range.getBoundingClientRect().x;
      }
    }
    const attachments=[...root.querySelectorAll('span')].flatMap(node=>['::before','::after'].map(pseudo=>({content:getComputedStyle(node,pseudo).content,pseudo,width:node.getBoundingClientRect().width}))).filter(value=>!['none','normal','\"\"',\"''\"].includes(value.content)&&value.content);
    const nativeHints=[...root.querySelectorAll('[class*=\"dyn-rule\"]')].filter(node=>node.textContent.trim()).length;
    return {positions,attachments,nativeHints,visibility:document.visibilityState,focused:document.hasFocus()};
  })()`);
}

exports.run = async () => {
  const fixture = JSON.parse(process.env.ESKA_HOST_FIXTURE), artifacts = process.env.ESKA_HOST_DOM_ARTIFACTS;
  let workbench, observation, latest, document, original, explorer, control; const samples=[];
  try {
    explorer = await vscode.extensions.all.find(value => value.packageJSON.name === 'eska-explorer').activate();
    await until(() => explorer.connection.state.kind === 'ready', 'metadata ready');
    assert.ok(explorer.connection.state.multilineStrings, 'API 1.34 geometry negotiated');
    document = await vscode.workspace.openTextDocument(fixture.languageSource.file); const disk = await fs.readFile(fixture.languageSource.file);
    let editor = await vscode.window.showTextDocument(document, { preview: false });
    original = document.getText();
    await until(() => explorer.tooling.states.analyzer.phase === 'ready', 'real analyzer ready');
    const initialPid = explorer.language.session.owner.child.pid;
    const alignment = () => explorer.language.session?.alignment;
    const count = () => { const value = alignment()?.displays.get(document); return value?.version === document.version ? value.decorations.length : 0; };
    assert.ok(alignment(), 'alignment controller created');
    workbench = await connectWorkbench(until); await workbench.focus();
    await vscode.commands.executeCommand('workbench.action.closeSidebar');
    await vscode.commands.executeCommand('workbench.action.closeAuxiliaryBar');
    await vscode.commands.executeCommand('workbench.action.closePanel');
    await workbench.viewport(1440, 900);
    if (artifacts) await fs.mkdir(artifacts, { recursive: true });
    for (const theme of ['Default Dark Modern','Default Light Modern']) {
      await vscode.workspace.getConfiguration('workbench').update('colorTheme',theme,vscode.ConfigurationTarget.Global);
      for (const [font,size] of [['DejaVu Sans',12],['monospace',18]]) for (const padding of [false,true]) for (const zoom of [0,1]) {
        stage=`matrix:${theme}:${font}:${padding}:${zoom}`;
        const settings=vscode.workspace.getConfiguration('editor');
        await settings.update('inlayHints.fontFamily',font,vscode.ConfigurationTarget.Global);
        await settings.update('inlayHints.fontSize',size,vscode.ConfigurationTarget.Global);
        await settings.update('inlayHints.padding',padding,vscode.ConfigurationTarget.Global);
        await vscode.workspace.getConfiguration('window').update('zoomLevel',zoom,vscode.ConfigurationTarget.Global);
        await settings.update('inlayHints.enabled','off',vscode.ConfigurationTarget.Global);
        let previous, stable=0;
        const off=await until(async()=>{
          const value=await geometry(workbench), signature=JSON.stringify(value.positions);
          stable=signature===previous?stable+1:0;previous=signature;
          return count()===0&&value.attachments.length===0&&value.nativeHints===0&&Object.keys(value.positions).length===phrases.length&&stable>=3&&value;
        },'all source positions stable with hints off');
        await settings.update('inlayHints.enabled','on',vscode.ConfigurationTarget.Global);
        await until(()=>count()>=12,'builtin, local and nested multiline hints align automatically');
        let shifts;
        const on=await until(async()=>{
          const value=await geometry(workbench);latest=value;if(Object.keys(value.positions).length!==phrases.length)return false;
          shifts=Object.fromEntries(phrases.map(phrase=>[phrase,value.positions[phrase]-off.positions[phrase]]));
          observation={off,on:value,shifts};
          const correct=[[phrases[0],phrases[1],phrases[2]],[phrases[3],phrases[4]],[phrases[5],phrases[6]],[phrases[8],phrases[9]],[phrases[10],phrases[11]]]
            .every(([first,...continuations])=>shifts[first]>1&&continuations.every(continuation=>Math.abs(shifts[first]-shifts[continuation])<1));
          return correct&&value;
        },'native source-text shifts match every continuation',7000);
        samples.push({theme,font,size,padding,zoom,shifts,attachments:on.attachments});
        if(artifacts)await fs.writeFile(path.join(artifacts,'progress.json'),JSON.stringify(samples,null,2));
      }
    }
    const focusSource=async()=>{
      const point=await workbench.evaluate("(()=>{const line=[...document.querySelectorAll('.monaco-editor .view-lines .view-line')].find(node=>node.getBoundingClientRect().width>0);const rect=line.getBoundingClientRect();return {x:rect.x+20,y:rect.y+8};})()");
      await workbench.click(point.x,point.y);
    };
    stage='edit-undo-redo';
    editor=vscode.window.activeTextEditor;
    await vscode.commands.executeCommand('workbench.action.focusActiveEditorGroup');
    control={settings:vscode.workspace.getConfiguration('files',document).get('readonlyInclude'),access:(await explorer.support?.readSource?.(document.uri.fsPath).catch(()=>undefined))?.header.protection,dom:await workbench.evaluate("[...document.querySelectorAll('.monaco-editor')].map(node=>({class:node.className,aria:node.getAttribute('aria-readonly'),inputs:[...node.querySelectorAll('[role=textbox]')].map(input=>({tag:input.tagName,aria:input.getAttribute('aria-readonly'),contenteditable:input.getAttribute('contenteditable')}))}))")};
    assert.equal(await editor.edit(edit=>edit.insert(new vscode.Position(0,0),'// temporary edit\r\n'),{undoStopBefore:true,undoStopAfter:true}),true);
    await until(()=>count()>=12,'edited geometry refreshed');
    await focusSource();
    await vscode.commands.executeCommand('undo');await until(()=>document.getText()===original&&count()>=12,'undo geometry',7000);
    await focusSource();
    await vscode.commands.executeCommand('redo');await until(()=>document.getText().startsWith('// temporary edit')&&count()>=12,'redo geometry',7000);
    await focusSource();
    await vscode.commands.executeCommand('undo');await until(()=>document.getText()===original&&count()>=12,'restore original geometry');
    assert.deepEqual(await fs.readFile(fixture.languageSource.file),disk);
    stage='split-editors';
    await vscode.commands.executeCommand('workbench.action.splitEditor');
    await until(()=>vscode.window.visibleTextEditors.filter(value=>value.document===document).length===2,'split editor');
    assert.ok(count()>=12);
    await vscode.commands.executeCommand('workbench.action.joinAllGroups');
    document=vscode.window.activeTextEditor.document;assert.equal(document.uri.fsPath,fixture.languageSource.file);
    await vscode.workspace.getConfiguration('window').update('zoomLevel',0,vscode.ConfigurationTarget.Global);
    if(artifacts)await workbench.screenshot(path.join(artifacts,'aligned.png'));
    assert.equal(document.isDirty,false);assert.equal(document.getText(),original);
    await vscode.commands.executeCommand('workbench.action.focusActiveEditorGroup');
    await vscode.commands.executeCommand('undo');assert.equal(document.getText(),original);
    stage='copy';
    const selection=new vscode.Range(document.positionAt(0),document.positionAt(original.length));
    await vscode.window.showTextDocument(document,{selection,preview:false});
    const copied=await workbench.evaluate(`(()=>{const data=new DataTransfer();const event=new ClipboardEvent('copy',{bubbles:true,cancelable:true,clipboardData:data});document.activeElement.dispatchEvent(event);return {text:data.getData('text/plain'),prevented:event.defaultPrevented};})()`);
    assert.equal(copied.text,original,'copy contains source without visual labels or padding');
    assert.equal(document.getText(),original);assert.equal(document.isDirty,false);
    stage='scroll';
    await workbench.viewport(1440,280);
    await vscode.commands.executeCommand('revealLine',{lineNumber:11,at:'top'});
    await until(async()=>count()>=12&&(await workbench.evaluate(`(()=>{const root=document.querySelector('.monaco-editor .view-lines'),box=root.getBoundingClientRect();return [...root.querySelectorAll('.view-line')].some(line=>line.textContent.includes('Его')&&line.getBoundingClientRect().y>=box.y&&line.getBoundingClientRect().y<box.bottom&&[...line.querySelectorAll('span')].some(span=>getComputedStyle(span,'::before').content.includes('Шаблон')));})()`)),'scrolled continuation keeps its prefix');
    await workbench.viewport(1440,900);await vscode.commands.executeCommand('revealLine',{lineNumber:0,at:'top'});
    await until(async()=>Object.keys((await geometry(workbench)).positions).length===phrases.length,'source visible after scrolling');
    stage='reopen';
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    await until(()=>!vscode.window.visibleTextEditors.some(value=>value.document===document),'source editor closed');
    assert.equal(alignment().styles.size,0,'hidden document releases all rendered styles');
    document=await vscode.workspace.openTextDocument(fixture.languageSource.file);editor=await vscode.window.showTextDocument(document,{preview:false});
    await until(()=>count()>=12,'reopened document geometry');
    assert.equal(document.getText(),original);
    stage='restart';
    await explorer.language.restart();
    await until(()=>explorer.tooling.states.analyzer.phase==='ready'&&explorer.language.session.owner.child.pid!==initialPid&&count()>=12,'restart clears and restores geometry');
    const result={passed:true,suite:'inlay-alignment',locale:vscode.env.language,vscode:vscode.version,samples,source_and_disk_unchanged:true,split:true,undo_redo:true,copy:true,scroll:true,reopen:true,restart:true,
      shutdownPids:[explorer.connection.child.pid,initialPid,explorer.language.session.owner.child.pid]};
    await fs.writeFile(path.join(fixture.root,'host-result.json'),JSON.stringify(result));
    if(artifacts)await fs.writeFile(path.join(artifacts,'result.json'),JSON.stringify(result,null,2));
  }catch(error){
    const result={passed:false,stage,error:String(error),stack:error?.stack,samples,observation,latest,editor:document?{version:document.version,closed:document.isClosed,dirty:document.isDirty,equal:document.getText()===original,prefix:document.getText().slice(0,120),active:vscode.window.activeTextEditor?.document.uri.toString(),activeVersion:vscode.window.activeTextEditor?.document.version,phase:explorer?.tooling.states.analyzer.phase,display:explorer?.language.session?.alignment?.displays.get(document)?.version}:undefined,control,activeElement:workbench?await workbench.evaluate("({tag:document.activeElement?.tagName,class:document.activeElement?.className})"):undefined,dom:workbench?await workbench.evaluate("[...document.querySelectorAll('.monaco-editor .view-lines')].map(node=>({text:node.textContent,html:node.innerHTML.slice(0,16000),width:node.getBoundingClientRect().width,height:node.getBoundingClientRect().height}))"):undefined};
    if(artifacts&&workbench)await workbench.screenshot(path.join(artifacts,'failure.png'));
    await fs.writeFile(path.join(fixture.root,'host-result.json'),JSON.stringify(result));
    if(artifacts)await fs.writeFile(path.join(artifacts,'result.json'),JSON.stringify(result,null,2));
    throw error;
  }finally{workbench?.close();}
};
