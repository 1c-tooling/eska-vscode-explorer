import { test } from "node:test";
import assert from "node:assert/strict";
import { MetadataTree } from "../out/tree.js";
import { parseWorkspace } from "../out/protocol.js";

function fixture() {
  const project = id => ({projectId:id,scope:{kind:"member",name:id},type:"processing",rootPath:{value:"/workspace/"+id,encoding:"utf-8"},sourcePath:{value:"/workspace/"+id+"/src",encoding:"utf-8"},root:{kind:"object",objectId:id},generation:"0",eventSequence:"0",requiresRefresh:false,requiresReopen:false,displayName:id,activity:{enabled:true,requiredBy:[]}});
  const session = {sessionId:"session",projects:[project("one"),project("two")],activity:{schemaVersion:1,revision:"a".repeat(64),hideDisabled:false}};
  let listener;
  const held = new Map(), calls=[];
  const connection = {onNotification(value) {listener=value;return {dispose(){}};},request(_session,method,params,signal) {
    calls.push({method,params,signal});
    return new Promise(resolve=>held.set(params.projectId,()=>resolve({sessionId:"session",projectId:params.projectId,generation:params.generation,eventSequence:params.generation,node:{id:{kind:"object",objectId:params.projectId},parent:null,label:{kind:"name",text:params.projectId},state:"unloaded",expandedByDefault:false,rootSection:false}})));
  }};
  const tree = new MetadataTree(connection,session,()=>{},()=>{});
  return {session,tree,held,calls,publish(value){listener("workspace/activityChanged",value);}};
}

test("activity retires a member's in-flight results while an unrelated root remains reusable",async()=>{
  const f=fixture(),[one,two]=f.tree.projects;
  const old=f.tree.root(one).then(()=>assert.fail("inactive response restored a root"),error=>assert.equal(error.code,"obsolete"));
  const other=f.tree.root(two);
  await new Promise(resolve=>setImmediate(resolve));
  const off=structuredClone(f.session);Object.assign(off.projects[0],{generation:"1",eventSequence:"1",activity:{enabled:false,requiredBy:[]}});
  f.publish(off);
  assert.equal(f.calls[0].signal.aborted,true);assert.equal(f.calls[1].signal.aborted,false);
  f.held.get("one")();f.held.get("two")();await old;const root=await other;
  assert.equal(one.nodes.size,0);assert.equal(one.root,undefined);
  assert.deepEqual(await f.tree.roots(),[root]);
  const count=f.calls.length;
  await assert.rejects(f.tree.root(one),error=>error.domain==="project_inactive");assert.equal(f.calls.length,count);
  const on=structuredClone(off);Object.assign(on.projects[0],{generation:"2",eventSequence:"2",activity:{enabled:true,requiredBy:[]}});f.publish(on);
  assert.equal(await f.tree.root(two),root,"active root identity and cache survive both transitions");
  const resumed=f.tree.root(one);await new Promise(resolve=>setImmediate(resolve));f.held.get("one")();await resumed;
  assert.equal(one.nodes.size,1);f.tree.dispose();
});

test("activity schemas reject malformed local state and preserve legacy sessions",()=>{
  const f=fixture();assert.deepEqual(parseWorkspace(f.session),f.session);
  for(const change of [value=>value.activity.revision="bad",value=>value.activity.hideDisabled=null,value=>value.projects[0].activity.enabled=1,value=>value.projects[0].activity.requiredBy=[{application:"app"}],value=>delete value.projects[0].displayName]) {
    const invalid=structuredClone(f.session);change(invalid);assert.throws(()=>parseWorkspace(invalid),error=>error.code==="protocolInvalid");
  }
  const old=structuredClone(f.session);delete old.activity;for(const project of old.projects){delete project.activity;delete project.displayName;}assert.deepEqual(parseWorkspace(old),old);f.tree.dispose();
});
