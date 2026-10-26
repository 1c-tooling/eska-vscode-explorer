const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const vscode = require('vscode');
const {connect,connectWorkbench} = require('./query-constructor-dom.cjs');
const {until,openQuery} = require('./query-modal-host.cjs');
const {ready} = require('./query-builder-host.cjs');

/** Read only process identities allocated by this installed test extension and its backend. */
async function memory(explorer,client) {
  const processes={};
  for(const [name,pid] of Object.entries({extensionHost:process.pid,backend:explorer.connection.child.pid})){
    const stat=await fs.readFile(`/proc/${pid}/smaps_rollup`,'utf8');
    processes[name]={pid,rssBytes:Number(/^Rss:\s+(\d+)/m.exec(stat)[1])*1024,pssBytes:Number(/^Pss:\s+(\d+)/m.exec(stat)[1])*1024};
  }
  return {processes,extensionHeap:process.memoryUsage(),rendererHeap:await client.memory()};
}

/** Compare the same installed UI actions and acknowledgement boundaries without requiring an analyzer. */
exports.run = async function(){
  const fixture=JSON.parse(process.env.ESKA_HOST_FIXTURE),rounds=[],rpc={},rpcTimings={};let client,workbench;
  try{
    const explorer=await vscode.extensions.all.find(value=>value.packageJSON.name==='eska-explorer').activate();
    await until(()=>explorer.tree&&explorer.connection.state.kind==='ready'&&!explorer.support.loading,'metadata ready');
    await vscode.commands.executeCommand('workbench.action.closeSidebar');
    await vscode.commands.executeCommand('workbench.action.closeAuxiliaryBar');
    await vscode.commands.executeCommand('workbench.action.closePanel');
    await vscode.commands.executeCommand('workbench.action.joinAllGroups');
    await vscode.workspace.getConfiguration('workbench').update('colorTheme','Default Dark Modern',vscode.ConfigurationTarget.Global);
    await vscode.workspace.getConfiguration('window').update('zoomLevel',0,vscode.ConfigurationTarget.Global);
    const disk=await fs.readFile(fixture.module),draft=await openQuery(vscode.Uri.file(fixture.module)),original=draft.getText();
    workbench=await connectWorkbench(until);await workbench.viewport(1280,800);
    const request=explorer.connection.child.request.bind(explorer.connection.child);
    explorer.connection.child.request=(method,...args)=>{rpc[method]=(rpc[method]??0)+1;const start=performance.now();return request(method,...args).finally(()=>{(rpcTimings[method]??=[]).push(performance.now()-start);});};
    for(let round=0;round<7;round++){
      const row={round,temperature:round===0?'first':'warm'},before={...rpc},started=performance.now();
      await vscode.commands.executeCommand('eska.explorer.queryConstructor',draft.uri);client=await connect(until);await ready(client);
      row.openMs=performance.now()-started;row.openRpc=Object.fromEntries(Object.entries(rpc).map(([key,value])=>[key,value-(before[key]??0)]).filter(([,value])=>value));
      row.layout=await client.evaluate(`(()=>{const fields=document.querySelector('[data-section=fields]'),pane=fields.getBoundingClientRect(),rows=[...fields.querySelectorAll('.row,tbody tr')],top=Math.max(pane.top,...[...fields.querySelectorAll('.section-title,.item-toolbar,thead')].map(node=>node.getBoundingClientRect().bottom));return {viewport:[innerWidth,innerHeight],visibleRows:rows.filter(node=>{const r=node.getBoundingClientRect();return r.top>=top&&r.bottom<=pane.bottom;}).length};})()`);
      await client.evaluate('document.querySelector("[data-section=fields] .action-add").click()');
      row.inputFrameMs=await client.evaluate(`new Promise(resolve=>{const input=document.querySelector('.expression [name=expression]');input.focus();const start=performance.now();input.value='UnfinishedExpression';input.dispatchEvent(new Event('input',{bubbles:true}));input.setSelectionRange(3,7);requestAnimationFrame(()=>requestAnimationFrame(()=>resolve(performance.now()-start)));})`);
      await client.evaluate('document.querySelector(".search input").value="Товары";document.querySelector(".search input").dispatchEvent(new Event("input",{bubbles:true}));document.querySelector(".search").requestSubmit()');
      await until(()=>client.evaluate('document.getElementById("root").getAttribute("aria-busy")==="false"&&document.querySelectorAll(".metadata-table").length===1'),'metadata refresh');
      row.retainedInput=await client.evaluate('({value:document.querySelector(".expression [name=expression]")?.value,focus:document.activeElement?.name,start:document.activeElement?.selectionStart,end:document.activeElement?.selectionEnd})');
      const profileOutput=round===1?process.env.ESKA_COMPACT_CPU_OUTPUT:undefined;
      const profileBefore=profileOutput?await client.startProfile():undefined;
      const addRpc={...rpc},addStart=performance.now();
      await client.evaluate(`for(const [key,value] of [['expression','99'],['alias','Performance']]){const input=document.querySelector('.expression [name='+key+']');input.value=value;input.dispatchEvent(new Event('input',{bubbles:true}));}document.querySelector('.expression').requestSubmit();`);
      await until(()=>client.evaluate('document.getElementById("root").getAttribute("aria-busy")==="false"&&document.querySelector(".query-preview pre").textContent.includes("99 AS Performance")'),'field acknowledged');
      row.addFieldMs=performance.now()-addStart;row.addFieldRpc=Object.fromEntries(Object.entries(rpc).map(([key,value])=>[key,value-(addRpc[key]??0)]).filter(([,value])=>value));
      if(profileOutput){
        const {profile,metrics}=await client.stopProfile();
        await fs.writeFile(profileOutput,JSON.stringify(profile));
        row.profile={before:profileBefore,after:metrics,file:profileOutput};
      }
      row.memory=await memory(explorer,client);
      await client.evaluate('document.querySelectorAll("header button")[1].click()');client.close();client=undefined;
      await until(()=>!explorer.queryDesigner.views.size&&vscode.window.activeTextEditor?.document.uri.toString()===draft.uri.toString(),'cancel returns draft');
      assert.equal(draft.getText(),original);rounds.push(row);
    }
    assert.deepEqual(await fs.readFile(fixture.module),disk);
    const report={passed:true,suite:'query-compact-performance',locale:vscode.env.language,rounds,rpc,rpcTimings,sourceAndDraftUnchanged:true,analyzer:false};
    const output=process.env.ESKA_COMPACT_PERF_OUTPUT;if(output)await fs.writeFile(output,JSON.stringify(report,null,2));
    await fs.writeFile(path.join(fixture.root,'host-result.json'),JSON.stringify(report));
  }catch(error){await fs.writeFile(path.join(fixture.root,'host-result.json'),JSON.stringify({passed:false,suite:'query-compact-performance',rounds,error:String(error.stack??error)}));throw error;
  }finally{client?.close();workbench?.close();}
};
