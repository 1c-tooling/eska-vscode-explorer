const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const vscode = require("vscode");
const { connectWorkbench } = require("./query-constructor-dom.cjs");

async function until(action, label) {
  const deadline = Date.now()+30000; let last;
  while (Date.now()<deadline) {
    try { const value=await action(); if(value)return value; } catch(error) {last=error;}
    await new Promise(done=>setTimeout(done,50));
  }
  throw new Error(label+(last?": "+last.stack:""));
}
async function bounded(promise,label) {
  let timer;
  try { return await Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error(label)),10000);})]); }
  finally {clearTimeout(timer);}
}
function project(rows, fixture) { return rows.find(row=>row.node&&path.relative(path.toNamespacedPath(row.project.info.rootPath.value),path.toNamespacedPath(fixture.root))===""); }

exports.run = async () => {
  const fixture=JSON.parse(process.env.ESKA_HOST_FIXTURE), members=fixture.grouping.members;
  const explorer=await vscode.extensions.all.find(value=>value.packageJSON.name==="eska-explorer").activate();
  let dom; const cases=[];
  try {
    await until(()=>explorer.connection.state.kind==="ready","workspace ready");
    await vscode.commands.executeCommand("eska.explorer.projects.focus");
    const top=()=>explorer.getChildren();
    let roots=await top();assert.equal(roots.filter(row=>row.node).length,4);assert.equal(roots.filter(row=>row.projectGroup).length,0);
    const base=project(roots,members.base), first=project(roots,members["extension-one"]);
    assert.ok(base&&first);const stableKey=first.key;
    await explorer.view.reveal(first,{select:true,expand:true});
    const visible=new Set(["extension-one","report-one","processing-one"]);
    const manifest=()=>"[workspace]\n[workspace.members.app]\nconfiguration='members/base'\nextensions="+"["+[...visible].filter(name=>name.startsWith("extension")).map(name=>"{path="+JSON.stringify("members/"+name)+"}").join(",")+"]"+"\nexternal_objects="+JSON.stringify([...visible].filter(name=>!name.startsWith("extension")).map(name=>"members/"+name))+"\n";
    async function change(name,add) {
      const old=explorer.connection.child.pid;
      if(add)visible.add(name);else visible.delete(name);
      await fs.writeFile(path.join(fixture.root,"eska.toml"),manifest());
      await until(()=>explorer.connection.state.kind==="ready"&&explorer.connection.child.pid!==old&&explorer.tree.projects.length===visible.size+1,"manifest reconnect");
      await until(()=>explorer.view.selection[0]?.project===explorer.tree.projects.find(project=>project.key===first.project.key),"surviving project selection");
      return top();
    }
    for(const [index,type] of ["extension","report","processing"].entries()) {
      roots=await change(type+"-two",true);
      const groups=roots.filter(row=>row.projectGroup);
      assert.equal(groups.length,index+1);
      assert.ok(project(roots,members.base),"configuration remains at the original level");
      for(const group of groups) {
        const children=await explorer.getChildren(group);assert.equal(children.length,2);
        assert.ok(children.every(row=>row.project.info.type===group.projectGroup));
        assert.ok(children.every(row=>explorer.getParent(row)===group));
        assert.equal(explorer.getParent(group),undefined);
        await explorer.view.reveal(group,{expand:true,select:false});
      }
      cases.push("independent_threshold_"+type);
    }
    const expected=vscode.env.language.startsWith("ru")?["Расширения","Отчеты","Обработки"]:["Extensions","Reports","Data processors"];
    const groups=roots.filter(row=>row.projectGroup);
    assert.deepEqual(groups.map(row=>explorer.getTreeItem(row).label).sort(),[...expected].sort());
    dom=await connectWorkbench(until);await dom.focus();
    await until(async()=>await dom.evaluate(`(()=>{const text=document.querySelector('.sidebar')?.textContent??document.body.textContent;return ${JSON.stringify(expected)}.every(label=>text.includes(label));})()`),"native localized virtual groups");
    await vscode.commands.executeCommand("eska.explorer.search");
    const search=explorer.searchView;search.picker.ignoreFocusOut=true;search.picker.value="Артикул";
    const result=await until(()=>!search.picker.busy&&search.picker.items.find(row=>row.project?.key===first.project.key&&row.hit?.name==="Артикул"),"grouped metadata search");
    await until(()=>!search.picker.busy,"search finished indexing");
    search.picker.activeItems=[result];
    await until(async()=>await dom.evaluate(`(()=>{const row=document.querySelector('.quick-input-list .monaco-list-row.focused');return !!row&&row.textContent.includes('extension-one');})()`),"native picker focused grouped result");
    await vscode.commands.executeCommand("workbench.action.acceptSelectedQuickOpenItem");
    await until(()=>!explorer.searchView&&explorer.view.selection[0]?.node?.label.text==="Артикул"&&explorer.view.selection[0]?.project.key===first.project.key,"search reveals inside a group");
    await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(members["extension-one"].module),{preview:false});
    await bounded(vscode.commands.executeCommand("eska.explorer.revealActiveFile"),"file reveal command");
    await until(()=>explorer.view.selection[0]?.node?.id.kind==="module"&&explorer.view.selection[0]?.project.key===first.project.key,"source reveals inside a group");
    const selectedKey=explorer.view.selection[0].key;
    await vscode.commands.executeCommand("eska.explorer.refresh");
    await until(()=>explorer.view.selection[0]?.key===selectedKey,"refresh retains selection");
    assert.ok(explorer.expanded.get(groups.find(row=>row.projectGroup==="extension").key),"expanded group retained");
    cases.push("native_search_reveal_file_refresh_selection_and_expansion");
    for(const [index,type] of ["extension","report","processing"].entries()) {
      roots=await change(type+"-two",false);
      assert.equal(roots.filter(row=>row.projectGroup).length,2-index);
      assert.ok(project(roots,members[type+"-one"]),"last member returns to the original level");
      assert.equal(explorer.view.selection[0].key,selectedKey,"descendant selection survives reparenting");
      cases.push("two_to_one_"+type);
    }
    const old=explorer.connection.child.pid;
    await fs.writeFile(path.join(fixture.root,"eska.toml"),"[workspace]\n[workspace.members.app]\nexternal_objects=['members/report-one','members/report-two']\n");
    await until(()=>explorer.connection.state.kind==="ready"&&explorer.connection.child.pid!==old,"group-only workspace ready");
    roots=await top();assert.equal(roots.filter(row=>row.node).length,0);assert.equal(roots.filter(row=>row.projectGroup).length,1);
    await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(members["report-one"].module),{preview:false});
    await bounded(vscode.commands.executeCommand("eska.explorer.revealActiveFile"),"file reveal command");
    await until(()=>explorer.view.selection[0]?.project.info.type==="report","cold reveal when every project is grouped");
    cases.push("all_project_roots_grouped_cold_reveal");
    const resultData={passed:true,suite:"project-groups",locale:vscode.env.language,vscode:vscode.version,cases,stable_project_key:stableKey,shutdownPids:[explorer.connection.child.pid]};
    const artifacts=process.env.ESKA_HOST_DOM_ARTIFACTS;
    if(artifacts){await fs.mkdir(artifacts,{recursive:true});await dom.screenshot(path.join(artifacts,"groups.png"));await fs.writeFile(path.join(artifacts,"result.json"),JSON.stringify(resultData,null,2));}
    await fs.writeFile(path.join(fixture.root,"host-result.json"),JSON.stringify(resultData));
  } catch(error) {
    const result={passed:false,suite:"project-groups",locale:vscode.env.language,cases,state:explorer.connection.state.kind,selection:explorer.view.selection.map(row=>({key:row.key,project:row.project?.key})),publication:explorer.publishedTree===explorer.tree,reads:explorer.treeReads.size,waiters:explorer.rootWaiters.size,error:String(error.stack??error)};
    if(process.env.ESKA_HOST_DOM_ARTIFACTS){await fs.mkdir(process.env.ESKA_HOST_DOM_ARTIFACTS,{recursive:true});await fs.writeFile(path.join(process.env.ESKA_HOST_DOM_ARTIFACTS,"result.json"),JSON.stringify(result,null,2));
      async function logs(directory){for(const entry of await fs.readdir(directory,{withFileTypes:true})){const file=path.join(directory,entry.name);if(entry.isDirectory())await logs(file);else if(["ESKA Explorer.log","exthost.log"].includes(entry.name))await fs.copyFile(file,path.join(process.env.ESKA_HOST_DOM_ARTIFACTS,entry.name==="exthost.log"?"exthost.log":"explorer.log"));}}
      await logs(path.join(path.dirname(fixture.root),"profile","logs"));
    }
    await fs.writeFile(path.join(fixture.root,"host-result.json"),JSON.stringify(result));throw error;
  } finally {dom?.close();}
};
