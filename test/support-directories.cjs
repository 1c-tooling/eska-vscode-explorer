const assert=require("node:assert/strict");
const Module=require("node:module");
const path=require("node:path");

const disposable=()=>({dispose(){}});
class EventEmitter {
  listeners=new Set();
  event=listener=>{this.listeners.add(listener);return {dispose:()=>this.listeners.delete(listener)};};
  fire(value){for(const listener of this.listeners)listener(value);}
  dispose(){this.listeners.clear();}
}
const source=path.join(path.parse(process.cwd()).root,"eska-support-test","src"), target=path.join(source,"Folder");
let type=2, stats=0, rules={};const calls=[],saved=new Map();
const uri=file=>({scheme:"file",fsPath:file,toString:()=>"file:"+file});
const api={EventEmitter,Uri:{file:uri},FileType:{File:1,Directory:2},ConfigurationTarget:{Workspace:2},
  FileDecoration:class{constructor(badge,tooltip){this.badge=badge;this.tooltip=tooltip;}},
  env:{language:"en"},window:{registerFileDecorationProvider:disposable,onDidChangeVisibleTextEditors:disposable,visibleTextEditors:[]},
  workspace:{onDidOpenTextDocument:disposable,onDidChangeConfiguration:disposable,textDocuments:[],
    workspaceFolders:[{uri:uri(path.dirname(source))}],getWorkspaceFolder:()=>({uri:uri(path.dirname(source))}),
    getConfiguration:()=>({get:(_key,fallback)=>_key==="supportPolicy"?true:fallback,inspect:()=>({workspaceValue:rules}),update:async(_key,value)=>{rules=value??{};}}),
    fs:{stat:async()=>{stats++;return {type};}}}};
const original=Module._load;Module._load=function(name,...args){return name==="vscode"?api:Reflect.apply(original,this,[name,...args]);};
let SupportController;
try{({SupportController}=require("../out/support.js"));}finally{Module._load=original;}
const project={info:{generation:"0",eventSequence:"0",sourcePath:{encoding:"utf-8",value:source},root:{objectId:"configuration:Test"}}};
const tree={session:{sessionId:"session"},projects:[project],request:async(_project,method,{paths})=>{
  calls.push(method);return {objects:[],diagnostics:[],files:paths.map(value=>({path:value,objects:[],readOnly:true,mixed:false,unknown:false}))};
}};
const context={workspaceState:{get:(key,fallback)=>saved.has(key)?saved.get(key):fallback,update:async(key,value)=>{saved.set(key,value);}}};
let repaint=0;const controller=new SupportController(context,()=>{repaint++;},message=>{throw new Error(message);});
async function until(predicate){const end=Date.now()+5000;while(!predicate()){assert.ok(Date.now()<end,"support made progress");await new Promise(done=>setTimeout(done,5));}}
(async()=>{
  try{
    controller.setTree(tree,true,false,true);
    // Native file decorations request parent directories again after a publication.
    let feedback=0;controller.onDidChangeFileDecorations(()=>{if(++feedback<20)controller.provideFileDecoration(uri(target));});
    controller.provideFileDecoration(uri(target));
    await until(()=>stats>0&&repaint>1);await new Promise(done=>setTimeout(done,120));await controller.serial;
    assert.equal(stats,1,"directory decorations cannot create a publication/query feedback loop");
    assert.deepEqual(calls,[],"directories never become supportFiles requests");
    assert.deepEqual(rules,{},"directories never gain file restrictions");
    // A source invalidation retires the classification, so a new file is checked normally.
    type=1;project.info.generation="1";controller.invalidate();
    controller.provideFileDecoration(uri(target));await until(()=>calls.length>0&&rules[target]===true);await controller.serial;
    assert.equal(controller.provideFileDecoration(uri(target)).badge,"🔒");
    assert.equal(stats,2,"the former directory is queried again after invalidation");
    console.log(JSON.stringify({passed:true,directory_feedback_stopped:true,file_transition_checked:true}));
  }finally{await controller.shutdown();}
})().catch(error=>{console.error(error);process.exitCode=1;});
