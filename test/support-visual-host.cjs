const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { promisify } = require('node:util');
const exec = promisify(require('node:child_process').execFile);
const vscode = require('vscode');

/** Poll native decorations without manufacturing a preview of the tree. */
async function until(predicate) {
  for (let i = 0; i < 300; i++) { if (await predicate()) return; await new Promise(resolve => setTimeout(resolve, 100)); }
  assert.fail('Support decorations did not settle');
}
/** Capture the actual native tree in installed themes using an explicit external capture helper. */
exports.run = async function () {
  const fixture = JSON.parse(process.env.ESKA_HOST_FIXTURE);
  const { descriptor } = await import('./fixture.mjs');
  const names = ['Locked', 'Supported', 'Own', 'Removed', 'Unknown'];
  const uuid = index => `${index}`.repeat(8) + '-' + `${index}`.repeat(4) + '-' + `${index}`.repeat(4) + '-' + `${index}`.repeat(4) + '-' + `${index}`.repeat(12);
  await fs.writeFile(path.join(fixture.source, 'Configuration.xml'), descriptor('Configuration', 'SupportQA', names.map(name => `<Catalog>${name}</Catalog>`).join('')));
  for (let i=0;i<names.length;i++) await fs.writeFile(path.join(fixture.source, 'Catalogs', names[i]+'.xml'), descriptor('Catalog', names[i]).replace(uuid(1), uuid(i+2)));
  await fs.mkdir(path.join(fixture.source, 'Ext'), {recursive:true});
  await fs.writeFile(path.join(fixture.source, 'Ext/ParentConfigurations.bin'), `{6,0,1,${uuid(1)},0,${uuid(1)},"1","Vendor","QA",3,0,0,${uuid(2)},${uuid(2)},1,0,${uuid(3)},${uuid(3)},2,0,${uuid(5)},${uuid(5)},0,0,0,1,0,0,0,1,0,1,0,1,1,1,1}`);
  /** All Git operations remain inside this run's disposable fixture. */
  const git = (...args) => exec('git',args,{cwd:fixture.root});
  await fs.writeFile(path.join(fixture.root,'.gitignore'), '.vscode/\n.eska/\nhost-result.json\n');
  await git('init');await git('config','user.name','QA');await git('config','user.email','qa@example.invalid');await git('add','.');await git('commit','-m','fixture');
  const lockedPath=path.join(fixture.source,'Catalogs/Locked.xml');
  await fs.appendFile(lockedPath,'\n');
  await fs.writeFile(path.join(fixture.source,'Catalogs/Unknown.xml'), 'malformed');
  await vscode.workspace.getConfiguration('window').update('title','ESKA Support QA',vscode.ConfigurationTarget.Workspace);
  const explorer=await vscode.extensions.all.find(value=>value.packageJSON.name==='eska-explorer').activate();
  await vscode.commands.executeCommand('eska.explorer.connect');
  const api=(await vscode.extensions.getExtension('vscode.git').activate()).getAPI(1);
  const repository=await api.openRepository(vscode.Uri.file(fixture.root));await repository.status();
  await until(()=>!explorer.support.loading);
  const roots=await explorer.getChildren();const root=roots.find(item=>item.node);
  const group=(await explorer.getChildren(root)).find(item=>item.node?.id.collection?.metadataKind==='catalog');
  const entries=await explorer.getChildren(group);
  const byName=Object.fromEntries(entries.map(entry=>[entry.node.label.text,entry]));
  await until(async()=> (await explorer.decorations.provideFileDecoration(explorer.getTreeItem(byName.Locked).resourceUri))?.badge==='M');
  const combined=await explorer.decorations.provideFileDecoration(explorer.getTreeItem(byName.Locked).resourceUri);
  assert.equal(combined.badge,'M');assert.equal(explorer.support.decoration(byName.Supported).badge,'S');
  assert.equal(explorer.support.decoration(byName.Own),undefined);assert.equal(explorer.support.decoration(byName.Removed),undefined);assert.equal(explorer.support.decoration(byName.Unknown),undefined);
  for (const [name, symbol] of [['Locked','lock'],['Supported','lock_open_right'],['Removed','no_encryption']]) {
    const item = explorer.getTreeItem(byName[name]);
    assert.ok(item.iconPath.path.endsWith(`-${symbol}.svg`), name);
    assert.match(await fs.readFile(item.iconPath.fsPath,'utf8'), /fill="#f59e0b"/);
  }
  assert.ok(!explorer.getTreeItem(byName.Own).iconPath.path.includes('/support/'));
  assert.ok(!explorer.getTreeItem(byName.Unknown).iconPath.path.includes('/support/'));
  // The icon is part of the synchronous tree item even with pending Git work.
  const savedSerial = explorer.decorations.serial;
  let releaseGit;
  explorer.decorations.serial = new Promise(resolve=>{releaseGit=resolve;});
  try {
    for(let i=0;i<1000;i++) assert.ok(explorer.getTreeItem(byName.Locked).iconPath.path.endsWith('-lock.svg'));
  } finally { releaseGit(); explorer.decorations.serial = savedSerial; }
  await vscode.commands.executeCommand('eska.explorer.projects.focus');
  await explorer.view.reveal(root,{expand:true,focus:true,select:false});
  await new Promise(resolve=>setTimeout(resolve,500));
  await explorer.view.reveal(group,{expand:true,focus:true,select:false});
  await vscode.commands.executeCommand('workbench.action.closeAllEditors');
  await new Promise(resolve=>setTimeout(resolve,1500));
  for (const [slug,theme] of [['dark','Default Dark Modern'],['light','Default Light Modern'],['contrast','Default High Contrast'],['contrast-light','Default High Contrast Light']]) {
    await vscode.workspace.getConfiguration('workbench').update('colorTheme',theme,vscode.ConfigurationTarget.Workspace);
    await new Promise(resolve=>setTimeout(resolve,800));
    if(process.env.ESKA_HOST_DEBUG_PORT && process.env.ESKA_SCREENSHOT_DIR) {
      await fs.mkdir(process.env.ESKA_SCREENSHOT_DIR,{recursive:true});
      const targets = await (await fetch(`http://127.0.0.1:${process.env.ESKA_HOST_DEBUG_PORT}/json/list`)).json();
      const target = targets.find(target => target.type === 'page' && target.url.startsWith('vscode-file:'));
      assert.ok(target, 'native workbench CDP target');
      const socket = new WebSocket(target.webSocketDebuggerUrl);
      await new Promise((resolve,reject)=> { socket.addEventListener('open',resolve,{once:true}); socket.addEventListener('error',reject,{once:true}); });
      let nextId=0;
      /** Use CDP only for native UI layout, mouse input and screenshot capture. */
      const send = (method,params={}) => new Promise((resolve,reject)=> {
        const id=++nextId;
        const listener=event=> { const response=JSON.parse(event.data); if(response.id!==id)return; socket.removeEventListener('message',listener); response.error?reject(new Error(JSON.stringify(response.error))):resolve(response.result); };
        socket.addEventListener('message',listener); socket.send(JSON.stringify({id,method,params}));
      });
      if(slug==='dark') {
        const result=await send('Runtime.evaluate',{expression:`JSON.stringify([...document.querySelectorAll('.pane-header')].filter(e=>e.innerText.includes('ESKA')).map(e=>{const r=e.getBoundingClientRect();return {x:r.x,y:r.y,width:r.width}}))`,returnByValue:true});
        const [header]=JSON.parse(result.result.value);
        assert.ok(header,'visible native ESKA pane');
        const x=header.x+header.width/2, y=header.y-2;
        await send('Input.dispatchMouseEvent',{type:'mouseMoved',x,y});
        await send('Input.dispatchMouseEvent',{type:'mousePressed',x,y,button:'left',clickCount:1});
        for(let target=y;target>160;target-=40) await send('Input.dispatchMouseEvent',{type:'mouseMoved',x,y:target,button:'left',buttons:1});
        await send('Input.dispatchMouseEvent',{type:'mouseReleased',x,y:160,button:'left',clickCount:1});
        await new Promise(resolve=>setTimeout(resolve,800));
      }
      const screenshot=(await send('Page.captureScreenshot',{format:'png'})).data;
      socket.close();
      await fs.writeFile(path.join(process.env.ESKA_SCREENSHOT_DIR,`support-${slug}.png`),Buffer.from(screenshot,'base64'));
    }
  }
  await fs.writeFile(path.join(fixture.root,'host-result.json'),JSON.stringify({passed:true,vscode:vscode.version,states:['locked','editableWithSupport','own','removed','unknown'],combinedGit:combined.tooltip,themes:4}));
};
