const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const vscode = require('vscode');

/** Wait for asynchronous native watcher and backend transitions. */
async function until(predicate) {
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) { if (await predicate()) return; await new Promise(resolve => setTimeout(resolve, 20)); }
  assert.fail('support transition timed out');
}

/** Hide the tree until protection is applied, and ignore byte-identical support rewrites. */
exports.run = async function () {
  const fixture = JSON.parse(process.env.ESKA_HOST_FIXTURE);
  const uuid = '11111111-1111-1111-1111-111111111111';
  const rules = mode => `{6,0,1,${uuid},${mode},${uuid},"1","Vendor","Test",1,1,0,${uuid},${uuid},0,0,0,1,0,0,0,1,0,1,0,1,1,1,1}`;
  const file = path.join(fixture.source,'Ext/ParentConfigurations.bin');
  await fs.mkdir(path.dirname(file),{recursive:true});
  await fs.writeFile(file,rules(1));
  const explorer = await vscode.extensions.all.find(value=>value.packageJSON.name==='eska-explorer').activate();
  let release;
  let barrier = new Promise(resolve=>{release=resolve;});
  const request = explorer.connection.request.bind(explorer.connection);
  let calls=0;
  explorer.connection.request=async(session,method,params,...rest)=>{
    if(method==='metadata/support') { calls++; await barrier; }
    return request(session,method,params,...rest);
  };
  try {
    await until(()=>calls>0);
    let rows=await explorer.getChildren();
    assert.equal(rows.length,1);
    assert.equal(rows[0].loading,true);
    assert.equal(explorer.getTreeItem(rows[0]).iconPath.id,'loading~spin');
    release();
    await until(()=>!explorer.support.loading);
    assert.equal(explorer.support.failed,false);
    rows=await explorer.getChildren();
    assert.ok(rows.some(row=>row.node));
    const uri=vscode.Uri.file(fixture.module);
    assert.equal(explorer.support.provideFileDecoration(uri).badge,'🔒');
    const beforeBsl=calls;
    await fs.appendFile(fixture.module,'\n// changed content\n');
    await new Promise(resolve=>setTimeout(resolve,800));
    assert.equal(calls,beforeBsl,'BSL content edit reuses support snapshot');
    assert.equal(explorer.support.loading,false);
    assert.equal(explorer.support.provideFileDecoration(uri).badge,'🔒');
    const previousCalls=calls;
    await fs.writeFile(file,rules(1));
    await new Promise(resolve=>setTimeout(resolve,1000));
    assert.equal(calls,previousCalls,'unchanged bytes do not restart analysis');
    assert.equal(explorer.support.loading,false);
    barrier = new Promise(resolve=>{release=resolve;});
    await fs.writeFile(file,rules(0));
    await until(()=>calls>previousCalls);
    rows=await explorer.getChildren();
    assert.equal(rows[0].loading,true,'changed rules hide stale tree');
    release();
    await until(()=>!explorer.support.loading);
    assert.equal(explorer.support.provideFileDecoration(uri).badge,'S');
    assert.ok((await explorer.getChildren()).some(row=>row.node));
    const beforeMissing=calls;
    await fs.unlink(file);
    await until(()=>calls>beforeMissing && !explorer.support.loading);
    assert.equal(explorer.support.provideFileDecoration(uri).badge,'?');
    const beforeRestored=calls;
    await fs.writeFile(file,rules(0));
    await until(()=>calls>beforeRestored && !explorer.support.loading);
    assert.equal(explorer.support.provideFileDecoration(uri).badge,'S','restored identical rules recover from missing file');
    await vscode.commands.executeCommand('eska.explorer.disconnect');
    await fs.writeFile(path.join(fixture.root,'host-result.json'),JSON.stringify({passed:true,preloader:true,unchangedRulesReuse:true,changedRulesRecheck:true,restoredFileRecheck:true,bslRetainsSupport:true}));
  } finally { release(); }
};
