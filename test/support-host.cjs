const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const vscode = require('vscode');
const exec = require('node:util').promisify(require('node:child_process').execFile);

/** Wait for actual filesystem invalidation and configuration publication. */
async function until(predicate, reason) {
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) { if (await predicate()) return; await new Promise(resolve => setTimeout(resolve, 100)); }
  assert.fail(reason);
}
/** Create controlled UUID rules without editing any supplied configuration. */
function support(mode, rule) {
  const owner = '11111111-1111-1111-1111-111111111111';
  const attribute = '22222222-2222-2222-2222-222222222222';
  return `{6,0,1,${owner},${mode},${owner},"1","Vendor","Fixture",2,${rule},0,${owner},${owner},0,0,${attribute},${attribute},0,0,0,1,0,0,0,1,0,1,0,1,1,1,1}`;
}
/** Acceptance uses native typing, ordinary file URIs and an unopened ESKA tree. */
exports.run = async function () {
  const fixture = JSON.parse(process.env.ESKA_HOST_FIXTURE);
  const supportPath = path.join(fixture.source, 'Ext/ParentConfigurations.bin');
  await fs.mkdir(path.dirname(supportPath), { recursive: true });
  await fs.writeFile(supportPath, support(0, 1));
  /** Git only operates on this test's temporary project. */
  const git = (...args) => exec('git', args, {cwd:fixture.root});
  await fs.writeFile(path.join(fixture.root,'.gitignore'),'.vscode/\n.eska/\n');
  await git('init','-b','editable');await git('config','user.name','QA');await git('config','user.email','qa@example.invalid');
  await git('add','.');await git('commit','-m','editable support');
  await git('switch','-c','locked');await fs.writeFile(supportPath,support(0,0));await git('commit','-am','locked support');await git('switch','editable');
  const uri = vscode.Uri.file(fixture.module);
  const files = vscode.workspace.getConfiguration('files', uri);
  await files.update('readonlyInclude', { '**/*.os': true }, vscode.ConfigurationTarget.Workspace);
  const explorer = await vscode.extensions.all.find(value => value.packageJSON.name === 'eska-explorer').activate();
  await until(() => explorer.support.provideFileDecoration(vscode.Uri.file(fixture.descriptor))?.badge === '🔒', 'mixed XML policy without expanding tree');
  assert.equal(explorer.support.provideFileDecoration(uri)?.badge, 'S');
  await until(() => !explorer.support.loading, 'complete initial publication');
  const journal = explorer.support.context.workspaceState;
  const owned = explorer.support.ownedRules();
  await journal.update('supportReadonlyRules.v1', owned);
  await journal.update('supportReadonlyRules.v2', undefined);
  await explorer.support.apply(owned);
  assert.equal(journal.get('supportReadonlyRules.v1'), undefined, 'legacy journal migrated');
  assert.ok(journal.get('supportReadonlyRules.v2').every(value => value.length === 44), 'journal retains only compact hashes');
  assert.deepEqual(explorer.support.ownedRules().sort(), [...owned].sort(), 'ownership recovered from exact existing settings');
  assert.equal(vscode.workspace.getConfiguration('files', uri).get('readonlyInclude')['**/*.os'], true);

  let editor = await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(vscode.Uri.file(fixture.descriptor)));
  let original = editor.document.getText();
  await vscode.commands.executeCommand('type', { text: 'blocked' });
  assert.equal(editor.document.getText(), original, 'mixed XML is readonly');
  editor = await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(uri));
  original = editor.document.getText();
  const userRules = {...vscode.workspace.getConfiguration('files',uri).get('readonlyInclude'),'**/*.bsl':true};
  await files.update('readonlyInclude',userRules,vscode.ConfigurationTarget.Workspace);
  await new Promise(resolve=>setTimeout(resolve,200));
  await vscode.commands.executeCommand('type',{text:'user blocked'});
  assert.equal(editor.document.getText(),original,'user BSL lock is independent of support permission');
  delete userRules['**/*.bsl'];await files.update('readonlyInclude',userRules,vscode.ConfigurationTarget.Workspace);
  await new Promise(resolve=>setTimeout(resolve,200));
  await vscode.commands.executeCommand('type', { text: '// allowed\n' });
  assert.notEqual(editor.document.getText(), original, 'separate module stays writable');
  const dirty = editor.document.getText();
  await git('switch','locked');
  await until(() => explorer.support.provideFileDecoration(uri)?.badge === '🔒', 'changed support applied');
  await vscode.commands.executeCommand('type', { text: 'blocked' });
  assert.equal(editor.document.getText(), dirty, 'dirty text preserved and further typing blocked');
  await fs.writeFile(supportPath,'corrupted');
  await until(()=>!explorer.support.loading && explorer.support.snapshots.size > 0 && explorer.support.provideFileDecoration(uri) === undefined,'corrupted support diagnosed without icon');
  await vscode.commands.executeCommand('type',{text:'still blocked'});
  assert.equal(editor.document.getText(),dirty,'corruption does not clear prior restriction');
  await fs.writeFile(supportPath,support(0,0));
  await until(()=>explorer.support.provideFileDecoration(uri)?.badge==='🔒','support recovered');
  await vscode.commands.executeCommand('workbench.action.files.setActiveEditorWriteableInSession');
  await vscode.commands.executeCommand('type', { text: '// override\n' });
  assert.notEqual(editor.document.getText(), dirty);
  assert.equal(await fs.readFile(fixture.module, 'utf8'), original);
  await git('switch','editable');
  await until(() => explorer.support.provideFileDecoration(uri)?.badge === 'S', 'unlocked object refreshed');
  assert.equal(vscode.workspace.getConfiguration('files', uri).get('readonlyInclude')['**/*.os'], true, 'user protection retained');
  await vscode.commands.executeCommand('eska.explorer.disconnect');
  await until(() => !Object.keys(vscode.workspace.getConfiguration('files', uri).get('readonlyInclude')).some(key => key.includes(fixture.source)), 'owned settings cleaned');
  assert.equal(vscode.workspace.getConfiguration('files', uri).get('readonlyInclude')['**/*.os'], true);
  await vscode.commands.executeCommand('workbench.action.revertAndCloseActiveEditor');
  await fs.writeFile(path.join(fixture.root, 'host-result.json'), JSON.stringify({ passed: true, vscode: vscode.version, mixedXml: true, unopenedTree: true, independentModule: true, dirtyPreserved: true, sessionOverride: true, userRulesRetained: true, branchSwitch: true, corruptedSupport: true }));
};
