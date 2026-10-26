const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const vscode = require('vscode');
const { connect, connectWorkbench } = require('./query-constructor-dom.cjs');
const { until, openQuery } = require('./query-modal-host.cjs');

/** Measure the installed renderer, keeping the former layout as evidence rather than asserting it already fits. */
exports.run = async function () {
  const fixture = JSON.parse(process.env.ESKA_HOST_FIXTURE), samples = [];
  const baseline = process.env.ESKA_LAYOUT_BASELINE === '1', artifacts = process.env.ESKA_HOST_DOM_ARTIFACTS;
  let client, workbench;
  try {
    assert.equal(await vscode.extensions.all.find(value => value.packageJSON.name === 'eska-explorer').activate(), undefined);
    await vscode.commands.executeCommand('eska.explorer.restart');
    const uri = vscode.Uri.file(fixture.module), disk = await fs.readFile(fixture.module);
    const draft = await openQuery(uri), original = draft.getText(), start = performance.now();
    await vscode.commands.executeCommand('workbench.action.joinAllGroups');
    await vscode.commands.executeCommand('workbench.action.closeSidebar');
    await vscode.commands.executeCommand('workbench.action.closeAuxiliaryBar');
    await vscode.commands.executeCommand('workbench.action.closePanel');
    await vscode.commands.executeCommand('eska.explorer.queryConstructor', draft.uri);
    client = await connect(until); workbench = await connectWorkbench(until);
    const openMs = performance.now() - start;
    if (artifacts) await fs.mkdir(artifacts, { recursive: true });
    for (const [slug, theme] of (baseline ? [['dark', 'Default Dark Modern']] : [
      ['dark', 'Default Dark Modern'], ['light', 'Default Light Modern'], ['contrast', 'Default High Contrast']])) {
      await vscode.workspace.getConfiguration('workbench').update('colorTheme', theme, vscode.ConfigurationTarget.Global);
      for (const [width, height] of [[1280, 800], [900, 650]]) for (const zoom of [100, 150]) {
        await workbench.viewport(width, height);
        await vscode.workspace.getConfiguration('window').update('zoomLevel', Math.log(zoom / 100) / Math.log(1.2), vscode.ConfigurationTarget.Global);
        await settleViewport(client);
        const geometry = await client.evaluate(`(() => {
          const root = document.getElementById('root'), header = root.querySelector('header'), fields = root.querySelector('[data-section="fields"]'), rows = [...fields.querySelectorAll('.row,tbody tr')];
          const bounds = node => {const {x,y,width,height}=node.getBoundingClientRect();return {x,y,width,height};};
          const pane=fields.getBoundingClientRect(),title=fields.querySelector('.section-title').getBoundingClientRect(), toolbar=fields.querySelector('.item-toolbar')?.getBoundingClientRect(),head=fields.querySelector('thead')?.getBoundingClientRect();
          return {viewport:{width:innerWidth,height:innerHeight},body:{width:document.body.scrollWidth,height:document.body.scrollHeight},
            header:bounds(header),row:rows[0]&&bounds(rows[0]),visibleRows:rows.filter(node=>{const r=node.getBoundingClientRect();return r.top>=Math.max(pane.top,title.bottom,toolbar?.bottom??0,head?.bottom??0,0)&&r.bottom<=Math.min(pane.bottom,innerHeight);}).length,
            compact:!!root.querySelector('.pane-separator'),buttons:[...header.querySelectorAll('button')].map(node=>({label:node.textContent,...bounds(node)}))};
        })()`);
        samples.push({ theme: slug, width, height, zoom, ...geometry });
        if (!baseline) {
          assert.ok(geometry.body.width <= geometry.viewport.width + 1, JSON.stringify(geometry));
          assert.ok(geometry.body.height <= geometry.viewport.height + 1, JSON.stringify(geometry));
          assert.ok(geometry.buttons.every(button => button.y >= 0 && button.y + button.height <= geometry.viewport.height), JSON.stringify(geometry));
          assert.ok(geometry.visibleRows > 0, JSON.stringify(geometry));
        }
        if (artifacts) await client.screenshot(path.join(artifacts, `${baseline?'before':'after'}-${vscode.env.language}-${slug}-${width}-${height}-${zoom}.png`));
      }
    }
    await vscode.workspace.getConfiguration('window').update('zoomLevel', 0, vscode.ConfigurationTarget.Global);
    await workbench.viewport(1280, 800);
    await settleViewport(client);
    if (!baseline) await exerciseState(client);
    await client.evaluate('document.querySelectorAll("header button")[1].click()');
    await until(() => vscode.window.activeTextEditor?.document.uri.toString() === draft.uri.toString(), 'layout cancel returned to draft');
    assert.equal(draft.getText(), original); assert.deepEqual(await fs.readFile(fixture.module), disk);
    const report = { passed: true, suite: 'query-layout', locale: vscode.env.language, baseline, openMs, samples, sourceAndDraftUnchanged: true };
    if (artifacts) await fs.writeFile(path.join(artifacts, `${baseline?'before':'after'}-${vscode.env.language}.json`), JSON.stringify(report, null, 2));
    await fs.writeFile(path.join(fixture.root, 'host-result.json'), JSON.stringify(report));
    console.log(JSON.stringify(report));
  } finally { client?.close(); workbench?.close(); }
};

/** Native zoom acknowledgements precede the webview's asynchronous resize; wait for its measured dimensions. */
async function settleViewport(client) {
  let previous, stable = 0;
  await until(async () => {
    await new Promise(resolve => setTimeout(resolve, 100));
    const dimensions = await client.evaluate('JSON.stringify([innerWidth,innerHeight,devicePixelRatio])');
    stable = dimensions === previous ? stable + 1 : 0; previous = dimensions; return stable >= 4;
  }, 'native theme/zoom/viewport settled');
}

/** Persistence is checked across actual tab navigation and asynchronous metadata model publications. */
async function exerciseState(client) {
  const scroll = await client.evaluate(`(() => {document.querySelector('.query-preview summary').click();
    const handle=document.querySelector('.preview-separator');handle.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowUp',bubbles:true}));
    const pane=document.querySelector('[data-section="fields"]');pane.scrollTop=140;const scroll=pane.scrollTop;
    document.getElementById('tab-joins').click();document.getElementById('tab-tablesFields').click();return scroll;})()`);
  assert.equal(await client.evaluate('document.querySelector(".query-preview").open'), true);
  assert.ok(scroll > 50);
  assert.ok(Math.abs(await client.evaluate('document.querySelector("[data-section=fields]").scrollTop') - scroll) < 1);
  const widths = await client.evaluate(`(() => {const h=document.querySelector('.pane-separator');h.focus();const before=h.getAttribute('aria-valuenow');h.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowRight',bubbles:true}));return {before,after:h.getAttribute('aria-valuenow')};})()`);
  assert.notEqual(widths.before, widths.after);
  const divider = await client.evaluate(`(() => {const h=document.querySelector('.pane-separator'),r=h.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2,width:h.getAttribute('aria-valuenow')};})()`);
  await client.pointer('mousePressed', divider.x, divider.y);
  await client.pointer('mouseMoved', divider.x + 50, divider.y);
  await client.pointer('mouseReleased', divider.x + 50, divider.y);
  await until(async () => await client.evaluate('document.querySelector(".pane-separator").getAttribute("aria-valuenow")') !== divider.width, 'native pointer resized panes');
  await client.evaluate(`document.querySelector('[data-section="fields"] .action-add').click();
    {const filter=document.querySelector('.expression-tools input');filter.value='Nested';filter.dispatchEvent(new Event('input',{bubbles:true}));}
    const input=document.querySelector('.expression [name="expression"]');input.value='UnfinishedExpression';input.dispatchEvent(new Event('input',{bubbles:true}));input.focus();input.setSelectionRange(3,7);
    globalThis.layoutFocusTrace=[];window.addEventListener('message',event=>{if(event.data?.type==='model'){const row={busy:event.data.busy,revision:event.data.model.revision,before:document.activeElement?.outerHTML?.slice(0,400)};layoutFocusTrace.push(row);queueMicrotask(()=>row.after=document.activeElement?.outerHTML?.slice(0,400));}},{capture:true});
    const search=document.querySelector('.search input');search.value='Товары';search.dispatchEvent(new Event('input',{bubbles:true}));document.querySelector('.search').requestSubmit();`);
  await until(() => client.evaluate('document.getElementById("root").getAttribute("aria-busy")==="false" && document.querySelectorAll(".metadata-table").length===1 && document.querySelector(".table-name").textContent==="Товары"'), 'layout metadata refresh');
  assert.equal(await client.evaluate('document.querySelector(".expression [name=expression]").value'), 'UnfinishedExpression');
  assert.equal(await client.evaluate('document.querySelector(".expression-tools input").value'), 'Nested');
  assert.ok((await client.evaluate('document.querySelector(".table-add").getAttribute("aria-label")')).includes('Товары'));
  assert.deepEqual(await client.evaluate('({name:document.activeElement.name,start:document.activeElement.selectionStart,end:document.activeElement.selectionEnd})'), {name:'expression',start:3,end:7}, JSON.stringify(await client.evaluate('layoutFocusTrace')));
  await client.evaluate('document.querySelector(".expression button:nth-last-child(2)").click()');
  const beforeChild = await client.evaluate('document.querySelector("[data-section=fields]").scrollTop');
  await client.evaluate('document.querySelector(".source-fields .edit-nested").click()');
  await until(() => client.evaluate('!!document.querySelector(".back-parent") && document.getElementById("root").getAttribute("aria-busy")==="false"'), 'nested layout ready');
  await client.evaluate('document.getElementById("tab-order").click();document.querySelector(".back-parent").click()');
  await until(() => client.evaluate('!document.querySelector(".back-parent") && document.getElementById("root").getAttribute("aria-busy")==="false"'), 'parent layout restored');
  assert.equal(await client.evaluate('document.getElementById("tab-tablesFields").getAttribute("aria-selected")'), 'true');
  assert.ok(Math.abs(await client.evaluate('document.querySelector("[data-section=fields]").scrollTop') - beforeChild) < 1);
  await client.evaluate('document.querySelector(".all-fields").focus();document.querySelector(".all-fields").click()');
  await until(() => client.evaluate('document.querySelector(".query-preview pre").textContent.includes("Child.NestedValue") && document.getElementById("root").getAttribute("aria-busy")==="false"'), 'text revision acknowledged');
  assert.equal(await client.evaluate('document.activeElement.classList.contains("all-fields")'), true, 'an accepted text revision retains the native action focus');
}
