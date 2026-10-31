const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const path=require('node:path');
const crypto=require('node:crypto');
const vscode=require('vscode');
const {connectWorkbench}=require('./query-constructor-dom.cjs');
let stage='bootstrap';
async function until(action,label){const deadline=Date.now()+45000;let last;while(Date.now()<deadline){try{const value=await action();if(value)return value;}catch(error){last=error;}await new Promise(done=>setTimeout(done,50));}throw new Error(label+(last?': '+last.stack:''));}
function alive(pid){try{process.kill(pid,0);return true;}catch(error){if(error.code==='ESRCH')return false;throw error;}}
async function sourceBytes(fixture){const result={};async function walk(root){for(const entry of await fs.readdir(root,{withFileTypes:true})){const file=path.join(root,entry.name);if(entry.isDirectory())await walk(file);else result[path.relative(fixture.root,file)]=crypto.createHash('sha256').update(await fs.readFile(file)).digest('hex');}}for(const member of Object.values(fixture.activity.members)){await walk(member.source);result[path.relative(fixture.root,path.join(member.root,'eska.toml'))]=crypto.createHash('sha256').update(await fs.readFile(path.join(member.root,'eska.toml'))).digest('hex');}result['eska.toml']=crypto.createHash('sha256').update(await fs.readFile(path.join(fixture.root,'eska.toml'))).digest('hex');return result;}
exports.run=async()=>{
 const fixture=JSON.parse(process.env.ESKA_HOST_FIXTURE),members=fixture.activity.members;
 const explorer=await vscode.extensions.all.find(value=>value.packageJSON.name==='eska-explorer').activate();
 const cases=[],pids=new Set();let dom;
 const named=name=>explorer.tree.projects.find(project=>project.info.scope.name===name);
 async function roots(){return explorer.getChildren();}
 async function row(name){const project=named(name);const group=explorer.projectGroups.parent(project);return (group?await explorer.getChildren(group):await roots()).find(row=>row.project===project);}
 async function activity(name,enabled){stage=(enabled?'enable_':'disable_')+name;await vscode.commands.executeCommand('eska.explorer.'+(enabled?'enableProject':'disableProject'),{project:named(name)});await until(()=>named(name).info.activity.enabled===enabled,stage);await explorer.language.activityChanged();await new Promise(done=>setTimeout(done,100));}
 async function definition(document,line,name,target){return until(async()=>{const column=document.lineAt(line).text.indexOf(name)+2;const values=await vscode.commands.executeCommand('vscode.executeDefinitionProvider',document.uri,new vscode.Position(line,column));return values?.some(value=>path.relative((value.targetUri??value.uri).fsPath,target)==='');},'definition '+name);}
 async function logs(){const folder=path.join(path.dirname(fixture.root),'profile','logs');let result='';async function walk(root){for(const entry of await fs.readdir(root,{withFileTypes:true})){const file=path.join(root,entry.name);if(entry.isDirectory())await walk(file);else if(entry.name==='ESKA Explorer.log')result+=await fs.readFile(file,'utf8');}}await walk(folder);return result;}
 try {
  await until(()=>explorer.connection.state.kind==='ready'&&explorer.tree?.projects.length===7,'workspace ready');
  const before=await sourceBytes(fixture);pids.add(explorer.connection.child.pid);
  if(process.env.ESKA_HOST_RUN==='1') {
    stage='IDE_restart';
    const saved=JSON.parse(await fs.readFile(path.join(fixture.root,'activity-restart-evidence.json'),'utf8'));
    assert.deepEqual(explorer.tree.session.activity,saved.activity);
    assert.deepEqual(explorer.tree.projects.map(project=>({name:project.info.scope.name,enabled:project.info.activity.enabled})),saved.projects);
    const dirty=await vscode.workspace.openTextDocument(saved.dirtyFile);await vscode.window.showTextDocument(dirty,{preview:false});
    assert.equal(dirty.getText(),await fs.readFile(saved.dirtyFile,'utf8'));
    assert.equal(explorer.language.session,undefined,'opening the disabled file after IDE restart stays inert');
    assert.deepEqual(await sourceBytes(fixture),saved.sourceBytes);
    cases.push('IDE_restart_restores_activity_and_filter','IDE_restart_open_disabled_does_not_activate_or_write_sources');
    const consumer=await vscode.workspace.openTextDocument(members['processing-one'].module);await vscode.window.showTextDocument(consumer,{preview:false});
    await until(()=>explorer.language.session?.owner&&explorer.tooling.states.analyzer.phase==='ready','restored active consumer ready');
    const pid=explorer.language.session.owner.child.pid;pids.add(pid);
    await activity('processing-two',true);assert.equal(explorer.language.session.owner.child.pid,pid);assert.equal(dirty.getText(),await fs.readFile(saved.dirtyFile,'utf8'));
    await until(()=>explorer.language.session.documents.wireVersion(dirty)!==undefined,'restored dirty native synchronized');
    cases.push('IDE_restart_enable_reuses_shared_lsp');
    const result={passed:true,suite:'project-activity-restart',locale:vscode.env.language,vscode:vscode.version,cases,shutdownPids:[...pids]};
    if(process.env.ESKA_HOST_DOM_ARTIFACTS){await fs.writeFile(path.join(process.env.ESKA_HOST_DOM_ARTIFACTS,'result-run-1.json'),JSON.stringify(result,null,2));await fs.writeFile(path.join(process.env.ESKA_HOST_DOM_ARTIFACTS,'result.json'),JSON.stringify(result,null,2));}
    await fs.writeFile(path.join(fixture.root,'host-result.json'),JSON.stringify(result));return;
  }
  if(fixture.activity.instrumented&&process.env.ESKA_HOST_ACTIVITY_CANCEL==='1') {
    stage='cancel_background_preparation';
    const loading=await vscode.workspace.openTextDocument(members['processing-two'].module);await vscode.window.showTextDocument(loading,{preview:false});
    const started=path.join(fixture.root,'.activity-validation-started');
    const validator=await until(async()=>Number(await fs.readFile(started,'utf8')),'validator started');pids.add(validator);
    await fs.rm(path.join(fixture.root,'.activity-validation-hold'));
    const start=Date.now();await activity('processing-two',false);
    assert.ok(Date.now()-start<5000,'disable cancels validation before the serial backend handles activity');
    await until(()=>!alive(validator),'cancelled validation child exited');
    await activity('processing-two',true);
    cases.push('native_disable_cancels_pending_preparation_and_reaps_validator');
  }
  await vscode.commands.executeCommand('eska.explorer.projects.focus');
  const consumer=await vscode.workspace.openTextDocument(members['processing-one'].module);await vscode.window.showTextDocument(consumer,{preview:false});
  await until(()=>explorer.tooling.states.analyzer.phase==='ready'&&explorer.language.session?.owner,'LSP ready');
  const pid=explorer.language.session.owner.child.pid;pids.add(pid);
  await definition(consumer,5,'Проверка',fixture.activity.baseDefinition);await definition(consumer,6,'Проверка',fixture.activity.extensionDefinition);
  cases.push('shared_base_and_extension_definitions');
  const dirty=await vscode.workspace.openTextDocument(members['processing-two'].module);await vscode.window.showTextDocument(dirty,{preview:false});
  const change=new vscode.WorkspaceEdit();change.insert(dirty.uri,dirty.positionAt(dirty.getText().length),'\n// unsaved before disabling\n');assert.equal(await vscode.workspace.applyEdit(change),true);const dirtyText=dirty.getText();
  await explorer.tree.request(named('processing-two'),'metadata/index',{action:'start'});
  const untouched=named('processing-one'),root=await explorer.tree.root(untouched),generation=untouched.info.generation,watcher=explorer.projectWatchers.get(untouched);
  await activity('processing-two',false);
  assert.equal(explorer.language.session.owner.child.pid,pid);assert.equal(await explorer.tree.root(untouched),root);assert.equal(untouched.info.generation,generation);assert.equal(explorer.projectWatchers.get(untouched),watcher);
  assert.equal(explorer.projectWatchers.has(named('processing-two')),false);assert.equal(named('processing-two').nodes.size,0);
  const disabled=await row('processing-two'),item=explorer.getTreeItem(disabled);assert.ok(disabled.inactive);assert.equal(item.contextValue,'eskaInactiveProject');assert.match(item.description,vscode.env.language.startsWith('ru')?/Отключён/:/Disabled/);
  assert.equal((await vscode.commands.executeCommand('vscode.executeDefinitionProvider',dirty.uri,new vscode.Position(7,10)))?.length??0,0);
  assert.equal(dirty.isDirty,true);assert.equal(dirty.getText(),dirtyText);
  const read=await explorer.connection.request(explorer.tree.session.sessionId,'metadata/root',{projectId:named('processing-two').info.projectId,generation:named('processing-two').info.generation}).then(()=>null,error=>error);assert.equal(read.domain,'project_inactive');
  if(fixture.activity.instrumented)await until(async()=>/evicting sources taken out by/.test(await fs.readFile(path.join(fixture.root,`.activity-lsp-${pid}.log`),'utf8')),'upstream evicts excluded VFS sources');
  await definition(consumer,5,'Проверка',fixture.activity.baseDefinition);
  cases.push('disable_during_index_drops_nodes_watchers_and_vfs_without_restarting_shared_lsp','disabled_file_does_not_analyse_or_activate','dirty_buffer_and_other_project_identity_preserved');
  await vscode.commands.executeCommand('eska.explorer.hideDisabledProjects');
  await until(()=>explorer.tree.session.activity.hideDisabled,'filter hidden');assert.equal((await roots()).some(row=>row.projectGroup==='processing'),false);assert.equal(explorer.projectGroups.parent(named('processing-one')),undefined);assert.equal(explorer.language.session.owner.child.pid,pid);
  await vscode.commands.executeCommand('eska.explorer.showDisabledProjects');await until(()=>!explorer.tree.session.activity.hideDisabled,'filter shown');assert.equal((await roots()).filter(row=>row.projectGroup==='processing').length,1);
  cases.push('persistent_filter_recalculates_t150_threshold_without_lsp_restart');
  const second=new vscode.WorkspaceEdit();second.insert(dirty.uri,dirty.positionAt(dirty.getText().length),'// edited while disabled\n');await vscode.workspace.applyEdit(second);const latest=dirty.getText();
  await activity('processing-two',true);assert.equal(dirty.getText(),latest);assert.equal(dirty.isDirty,true);assert.equal(explorer.language.session.owner.child.pid,pid);
  await until(()=>explorer.language.session.documents.wireVersion(dirty)!==undefined,'latest dirty buffer resynchronized');
  await vscode.window.showTextDocument(dirty,{preview:false});await vscode.commands.executeCommand('undo');assert.equal(dirty.getText(),dirtyText);await vscode.commands.executeCommand('redo');assert.equal(dirty.getText(),latest);
  cases.push('enable_reopens_latest_native_buffer_and_preserves_undo_redo');
  await activity('base',false);await activity('extension-one',false);await activity('extension-two',false);
  for(const name of ['base','extension-one','extension-two'])assert.ok(named(name).info.activity.requiredBy.length>0);
  assert.ok(named('base').info.activity.requiredBy.some(value=>value.application==='other'));
  const required=explorer.getTreeItem(await row('base'));assert.match(required.tooltip,vscode.env.language.startsWith('ru')?/Нужен активным/:/Required by active/);
  await definition(consumer,5,'Проверка',fixture.activity.baseDefinition);await definition(consumer,6,'Проверка',fixture.activity.extensionDefinition);assert.equal(explorer.language.session.owner.child.pid,pid);
  cases.push('disabled_dependencies_show_consumers_across_applications_and_preserve_shared_definitions');
  // The last active consumer of the selected application releases its complete LSP context.
  for(const name of ['report-one','processing-two','report-two','processing-one'])await activity(name,false);
  await until(()=>!explorer.language.session&&!alive(pid),'last consumer exits');assert.equal(explorer.projectWatchers.size,0);assert.ok(explorer.tree.projects.every(project=>project.nodes.size===0));
  cases.push('last_consumer_releases_lsp_metadata_and_project_watchers');
  await vscode.commands.executeCommand('eska.explorer.hideDisabledProjects');await until(()=>explorer.tree.session.activity.hideDisabled,'all hidden');assert.equal((await roots()).filter(row=>row.project||row.projectGroup).length,0);
  dom=await connectWorkbench(until);await dom.focus();await vscode.commands.executeCommand('eska.explorer.projects.focus');
  const show=vscode.env.language.startsWith('ru')?'Показать отключенные':'Show disabled projects';
  await until(async()=>await dom.evaluate(`Array.from(document.querySelectorAll('[aria-label]')).some(element=>(element.getAttribute('aria-label')??'').includes(${JSON.stringify(show)}))`),'show action exists with all projects hidden');
  const previousBackend=explorer.connection.child.pid;await vscode.commands.executeCommand('eska.explorer.restart');await until(()=>explorer.connection.state.kind==='ready'&&explorer.connection.child.pid!==previousBackend,'backend restarted');pids.add(explorer.connection.child.pid);
  assert.equal(explorer.tree.session.activity.hideDisabled,true);assert.ok(explorer.tree.projects.every(project=>!project.info.activity.enabled));assert.equal(explorer.language.session,undefined);assert.equal(dirty.getText(),latest);assert.equal(dirty.isDirty,true);
  await vscode.window.showTextDocument(dirty,{preview:false});await new Promise(done=>setTimeout(done,250));assert.equal(explorer.language.session,undefined);
  cases.push('backend_restart_restores_hidden_inactive_workspace_and_dirty_buffer','all_hidden_keeps_show_action_and_open_does_not_start_lsp');
  await vscode.commands.executeCommand('eska.explorer.showDisabledProjects');await until(()=>!explorer.tree.session.activity.hideDisabled,'show all disabled');
  assert.equal((await roots()).filter(row=>row.projectGroup).length,3);
  await activity('processing-one',true);await until(()=>explorer.tooling.states.analyzer.phase==='ready'&&explorer.language.session?.owner,'last consumer enabled');pids.add(explorer.language.session.owner.child.pid);
  await definition(consumer,5,'Проверка',fixture.activity.baseDefinition);assert.equal(named('base').info.activity.enabled,false);assert.ok(named('base').info.activity.requiredBy.length);
  assert.deepEqual(await sourceBytes(fixture),before);
  cases.push('explicit_enable_restores_dependency_context_without_rewriting_sources_or_manifests');
  await vscode.commands.executeCommand('eska.explorer.hideDisabledProjects');await until(()=>explorer.tree.session.activity.hideDisabled,'save filter before IDE restart');
  await fs.writeFile(path.join(fixture.root,'activity-restart-evidence.json'),JSON.stringify({activity:explorer.tree.session.activity,projects:explorer.tree.projects.map(project=>({name:project.info.scope.name,enabled:project.info.activity.enabled})),dirtyFile:dirty.uri.fsPath,dirtyText:latest,sourceBytes:before}));
  if(fixture.activity.instrumented&&process.env.ESKA_HOST_DOM_ARTIFACTS)await fs.copyFile(path.join(fixture.root,`.activity-lsp-${pid}.log`),path.join(process.env.ESKA_HOST_DOM_ARTIFACTS,'lsp.log'));
  const result={passed:true,suite:'project-activity',locale:vscode.env.language,vscode:vscode.version,cases,sharedPid:pid,shutdownPids:[...pids]};
  if(process.env.ESKA_HOST_DOM_ARTIFACTS)await fs.writeFile(path.join(process.env.ESKA_HOST_DOM_ARTIFACTS,'result-run-0.json'),JSON.stringify(result,null,2));
  if(process.env.ESKA_HOST_DOM_ARTIFACTS)await fs.writeFile(path.join(process.env.ESKA_HOST_DOM_ARTIFACTS,'result.json'),JSON.stringify(result,null,2));
  await fs.writeFile(path.join(fixture.root,'host-result.json'),JSON.stringify(result));
 }catch(error){const result={passed:false,suite:'project-activity',stage,locale:vscode.env.language,cases,error:String(error.stack??error)};if(process.env.ESKA_HOST_DOM_ARTIFACTS){await fs.writeFile(path.join(process.env.ESKA_HOST_DOM_ARTIFACTS,'result.json'),JSON.stringify(result,null,2));await fs.writeFile(path.join(process.env.ESKA_HOST_DOM_ARTIFACTS,'explorer.log'),await logs());}await fs.writeFile(path.join(fixture.root,'host-result.json'),JSON.stringify(result));throw error;}finally{dom?.close();}
};
