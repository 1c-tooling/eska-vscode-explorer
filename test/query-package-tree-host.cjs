const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const path=require('node:path');
const vscode=require('vscode');
const {connect}=require('./query-constructor-dom.cjs');
const {until,openQuery}=require('./query-modal-host.cjs');
const {ready}=require('./query-builder-host.cjs');

/** Package navigation uses backend identities after a copied operator changes the flat statement indices. */
exports.run=async function(){
 const f=JSON.parse(process.env.ESKA_HOST_FIXTURE);let client;
 try{
  await vscode.extensions.all.find(value=>value.packageJSON.name==='eska-explorer').activate();await vscode.commands.executeCommand('eska.explorer.restart');
  const disk=await fs.readFile(f.module),draft=await openQuery(vscode.Uri.file(f.module)),text='SELECT Q.N AS N INTO Tmp FROM (SELECT 7 AS N) AS Q; SELECT Tmp.N FROM Tmp; DROP Tmp';
  const edit=new vscode.WorkspaceEdit();edit.replace(draft.uri,new vscode.Range(draft.positionAt(0),draft.positionAt(draft.getText().length)),text);assert.equal(await vscode.workspace.applyEdit(edit),true);
  await vscode.commands.executeCommand('eska.explorer.queryConstructor',draft.uri);client=await connect(until);await ready(client);
  await client.evaluate('document.getElementById("tab-packages").click();document.querySelector(".copy-statement").click()');await until(()=>client.evaluate('!!document.querySelector(".action-preview")'),'copy preview');await ready(client);assert.match(await client.evaluate('document.querySelector(".preview-diff").textContent'),/INTO Tmp2/);
  await client.evaluate('document.querySelector(".preview-accept").click()');await until(()=>client.evaluate('document.querySelector(".temporary-destination input")?.value==="Tmp2"'),'copy focus returned by core');await ready(client);
  assert.ok(await client.evaluate('document.querySelectorAll(".package-tree .package-tree").length')>=2);
  await client.evaluate('[...document.querySelectorAll(".tree-branch")].find(node=>node.textContent.includes("SELECT Tmp.N FROM Tmp")).click();document.getElementById("tab-tablesFields").click()');await ready(client);
  await until(()=>client.evaluate('!!document.querySelector(".temporary-definition")'),'temporary definition link');await client.evaluate('document.querySelector(".temporary-definition").click()');await until(()=>client.evaluate('document.querySelector("header select")?.selectedIndex===0'),'original producer opened');await ready(client);await client.evaluate('document.getElementById("tab-tablesFields").click()');await until(()=>client.evaluate('!!document.querySelector(".source-tree[data-source=Q]")'),'producer source fields');
  await client.evaluate('document.querySelector(".source-fields .edit-nested").click()');await until(()=>client.evaluate('!!document.querySelector(".scope-path")'),'nested breadcrumb');assert.ok(await client.evaluate('document.querySelectorAll(".scope-crumb").length')>=2);
  await client.evaluate('document.querySelector(".back-parent").click()');await until(()=>client.evaluate('!document.querySelector(".scope-path")'),'returned to producer');await ready(client);
  const changed=await client.evaluate('document.getElementById("query-text").textContent');assert.equal(changed.match(/SELECT Tmp.N FROM Tmp/g).length,1);
  const appliedText=changed.replace(/\r?\n/g,draft.eol===vscode.EndOfLine.CRLF?'\r\n':'\n');
  await client.evaluate('document.querySelector("header button").click()');client.close();client=undefined;await until(()=>draft.getText()===appliedText,'package applied');await vscode.commands.executeCommand('undo');assert.equal(draft.getText(),text);assert.deepEqual(await fs.readFile(f.module),disk);
  await fs.writeFile(path.join(f.root,'host-result.json'),JSON.stringify({passed:true,suite:'query-package-tree',locale:vscode.env.language,accepted:['copy-preview-fresh-destination','copy-focus','nested-package-tree','lifetime-bound-definition-link','scope-breadcrumb-and-return','original-consumer-unchanged','native-undo','source-unchanged']}));
 }finally{client?.close();}
};
