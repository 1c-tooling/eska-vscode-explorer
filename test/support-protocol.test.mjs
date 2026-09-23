import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { Connection } from '../out/connection.js';
import { createTreeProject } from './fixture.mjs';

/** Use the real protocol in both locales; identities and policy fields must remain identical. */
test('support capability and paginated policies are independent of locale', { skip: !process.env.ESKA_TEST_BINARY }, async t => {
  const root=await mkdtemp(join(resolve('../eska-playground'),'support-protocol-'));
  t.after(()=>rm(root,{recursive:true,force:true}));
  const fixture=await createTreeProject(join(root,'project'));
  await mkdir(join(fixture.source,'Ext'),{recursive:true});
  const id='11111111-1111-1111-1111-111111111111';
  const child='22222222-2222-2222-2222-222222222222';
  await writeFile(join(fixture.source,'Ext/ParentConfigurations.bin'),`{6,0,1,${id},0,${id},"1","Vendor","Fixture",2,1,0,${id},${id},0,0,${child},${child},0,0,0,1,0,0,0,1,0,1,0,1,1,1,1}`);
  let expected;
  for(const locale of ['ru-RU','en-US']) {
    const connection=new Connection('test',()=>{},()=>{});
    try {
      await connection.connect({executable:process.env.ESKA_TEST_BINARY,path:fixture.root,name:'test',locale});
      const state=connection.state;assert.equal(state.kind,'ready');assert.equal(state.supportPolicy,true);
      const project=state.session.projects[0];
      const context={projectId:project.projectId,generation:project.generation};
      const result=await connection.request(state.session.sessionId,'metadata/support',context);
      assert.equal(result.nextOffset,null);assert.deepEqual(result.diagnostics,[]);
      assert.equal(result.objects.find(object=>object.uuid===child).state,'locked');
      assert.equal(result.files.find(file=>file.path.value.endsWith('Товары.xml')).mixed,true);
      assert.equal(result.files.find(file=>file.path.value.endsWith('Товары.xml')).reason,'mixedObjects');
      assert.equal(result.files.find(file=>file.path.value.endsWith('ObjectModule.bsl')).reason,'noSupportRestriction');
      assert.equal(result.files.find(file=>file.path.value.endsWith('ObjectModule.bsl')).readOnly,false);
      const stable={objects:result.objects,files:result.files,suppliers:result.suppliers};
      if(expected)assert.deepEqual(stable,expected);else expected=stable;
      await assert.rejects(connection.request(state.session.sessionId,'metadata/support',{...context,offset:99}));
      await assert.rejects(connection.request(state.session.sessionId,'metadata/support',{...context,generation:'999'}));
    } finally { await connection.dispose(); }
  }
});
