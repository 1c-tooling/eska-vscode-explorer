const vscode = require('vscode');
const fs = require('node:fs/promises');
const path = require('node:path');
const assert = require('node:assert/strict');

/** Wait only for a concrete bounded acceptance condition, retaining a useful failure label. */
async function until(condition, label) {
  for (let i = 0; i < 100; i++) {
    if (await condition()) return;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error(label);
}

/** Attach to the actual property frame so DOM events exercise the packaged webview script. */
async function frame(tab) {
  const targets = await (await fetch(`http://127.0.0.1:${process.env.ESKA_HOST_DEBUG_PORT}/json/list`)).json();
  const socket = new WebSocket(targets.find(item => item.type === 'page' && item.url.startsWith('vscode-file:')).webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', reject, { once: true }); });
  let serial = 0;
  const pending = new Map(), contexts = [];
  socket.addEventListener('message', event => {
    const message = JSON.parse(event.data);
    if (message.method === 'Runtime.executionContextCreated') contexts.push({ id: message.params.context.id, sessionId: message.sessionId });
    const promise = pending.get(message.id);
    if (promise) { pending.delete(message.id); message.error ? promise.reject(message.error) : promise.resolve(message.result); }
  });
  /** Match command replies independently of context notifications. */
  function send(method, params = {}, sessionId) {
    return new Promise((resolve, reject) => { const id = ++serial; pending.set(id, { resolve, reject }); socket.send(JSON.stringify({ id, method, params, sessionId })); });
  }
  await send('Runtime.enable');
  const all = await send('Target.getTargets');
  for (const target of all.targetInfos.filter(item => item.type === 'iframe')) {
    const { sessionId } = await send('Target.attachToTarget', { targetId: target.targetId, flatten: true });
    await send('Runtime.enable', {}, sessionId);
  }
  let context;
  await until(async () => {
    for (const candidate of contexts) {
      try {
        const result = await send('Runtime.evaluate', { contextId: candidate.id, expression: `document.getElementById('title')?.textContent === ${JSON.stringify(tab.state.title)}`, returnByValue: true }, candidate.sessionId);
        if (result.result?.value) { context = candidate; return true; }
      } catch {}
    }
    return false;
  }, 'property frame');
  return {
    /** Evaluate test code solely in this task's isolated property webview. */
    async evaluate(expression) {
      const result = await send('Runtime.evaluate', { contextId: context.id, expression, returnByValue: true, awaitPromise: true }, context.sessionId);
      if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
      return result.result?.value;
    },
    /** Preserve visual evidence from the actual native editor window. */
    async screenshot(name) {
      if (!process.env.ESKA_SCREENSHOT_DIR) return;
      const result = await send('Page.captureScreenshot', { format: 'png' });
      await fs.writeFile(path.join(process.env.ESKA_SCREENSHOT_DIR, name), Buffer.from(result.data, 'base64'));
    },
    close() { socket.close(); },
  };
}

/** Check lock, autosave, Esc, saved undo/redo and conflict drafts in an isolated native host. */
exports.run = async function () {
  const fixture = JSON.parse(process.env.ESKA_HOST_FIXTURE);
  const file = path.join(fixture.source, 'Configuration.xml');
  let original = await fs.readFile(file, 'utf8');
  original = original.replace('</Properties>', '<ScriptVariant>Russian</ScriptVariant><IncludeHelpInContents>false</IncludeHelpInContents></Properties>');
  await fs.writeFile(file, original);
  await fs.mkdir(path.join(fixture.source, 'Ext'), { recursive: true });
  await fs.writeFile(path.join(fixture.source, 'Ext/ParentConfigurations.bin'), '{6,0,0,0,0,0}');
  await vscode.workspace.getConfiguration('eska.explorer').update('executable', process.env.ESKA_TEST_BINARY, vscode.ConfigurationTarget.Workspace);
  const extension = vscode.extensions.all.find(item => item.packageJSON.name === 'eska-explorer');
  const explorer = await extension.activate();
  await vscode.commands.executeCommand('eska.explorer.connect');
  const [root] = (await explorer.getChildren()).filter(entry => entry.node);
  await vscode.commands.executeCommand('eska.explorer.properties', root);
  const [tab] = explorer.propertiesTabs.tabs.values();
  assert.equal(tab.state.editing.unlocked, false);
  const dom = await frame(tab);
  try {
    await dom.evaluate("document.getElementById('read-only').click()");
    await until(() => tab.state.editing.unlocked, 'unlock');
    const index = tab.state.editing.schema.fields.findIndex(field => field.path[0].key.name === 'Comment');
    const selector = `document.getElementById('edit-${index}')`;
    await until(() => dom.evaluate(`Boolean(${selector})`), 'edit controls');
    await dom.evaluate(`(()=>{const input=${selector}; input.focus();input.value='Changed <field>';input.dispatchEvent(new Event('input'));input.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}));})()`);
    await until(async () => !tab.state.editing.busy && (await fs.readFile(file, 'utf8')).includes('Changed &lt;field&gt;'), 'text autosave');
    assert.equal(await fs.readFile(file, 'utf8'), original.replace('😀 Кириллица', 'Changed &lt;field&gt;'));
    await dom.evaluate("window.dispatchEvent(new KeyboardEvent('keydown',{key:'z',ctrlKey:true,bubbles:true}))");
    await until(async () => !tab.state.editing.busy && await fs.readFile(file, 'utf8') === original, 'saved undo');
    await dom.evaluate("window.dispatchEvent(new KeyboardEvent('keydown',{key:'Z',ctrlKey:true,shiftKey:true,bubbles:true}))");
    await until(async () => !tab.state.editing.busy && (await fs.readFile(file, 'utf8')).includes('Changed &lt;field&gt;'), 'saved redo');
    const saved = await fs.readFile(file, 'utf8');
    await dom.evaluate(`(()=>{const input=${selector};input.value='cancel';input.dispatchEvent(new Event('input'));input.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}));input.dispatchEvent(new Event('blur'));})()`);
    await until(() => Object.keys(tab.state.editing.drafts).length === 0, 'Esc clears draft');
    assert.equal(await fs.readFile(file, 'utf8'), saved);
    const booleanIndex = tab.state.editing.schema.fields.findIndex(field => field.path[0].key.name === 'IncludeHelpInContents');
    const booleanSelector = `document.getElementById('edit-${booleanIndex}')`;
    const hit = await dom.evaluate(`(()=>{const input=${booleanSelector};input.scrollIntoView({block:'center'});const rect=input.getBoundingClientRect();const hit=document.elementFromPoint(rect.x+rect.width/2,rect.y+rect.height/2);return hit===input;})()`);
    assert.equal(hit, true, 'the checkbox square itself receives pointer input');
    await dom.evaluate(`${booleanSelector}.click()`);
    await until(async () => !tab.state.editing.busy && (await fs.readFile(file, 'utf8')).includes('<IncludeHelpInContents>true'), 'checkbox autosave');
    await dom.evaluate("window.dispatchEvent(new KeyboardEvent('keydown',{key:'z',ctrlKey:true,bubbles:true}))");
    await until(async () => !tab.state.editing.busy && (await fs.readFile(file, 'utf8')) === saved, 'checkbox undo');
    await dom.evaluate(`document.querySelector('label[for="edit-${booleanIndex}"]').click()`);
    await until(async () => !tab.state.editing.busy && (await fs.readFile(file, 'utf8')).includes('<IncludeHelpInContents>true'), 'checkbox label autosave');
    await dom.evaluate("window.dispatchEvent(new KeyboardEvent('keydown',{key:'z',ctrlKey:true,bubbles:true}))");
    await until(async () => !tab.state.editing.busy && (await fs.readFile(file, 'utf8')) === saved, 'checkbox label undo');
    await dom.screenshot('editing.png');
    await dom.evaluate(`(()=>{const input=${selector};input.value='Keep my draft';input.dispatchEvent(new Event('input'));})()`);
    await until(() => Object.keys(tab.state.editing.drafts).length === 1, 'host retains draft');
    await fs.writeFile(file, saved.replace('Changed &lt;field&gt;', 'External'));
    await tab.checkExternalChange();
    assert.equal(tab.state.editing.blocked, true);
    assert.equal(Object.values(tab.state.editing.drafts)[0].value, 'Keep my draft');
    await dom.evaluate("document.getElementById('refresh').click()");
    await until(() => tab.state.status === 'ready' && !tab.state.editing.blocked, 'explicit reread');
    assert.equal(Object.values(tab.state.editing.drafts)[0].value, 'Keep my draft');
    assert.ok((await fs.readFile(file, 'utf8')).includes('External'));
    assert.equal(await dom.evaluate('document.documentElement.scrollWidth > innerWidth'), false);
    tab.dispose();
    await vscode.commands.executeCommand('eska.explorer.properties', root);
    const [reopened] = explorer.propertiesTabs.tabs.values();
    assert.equal(reopened.state.editing.unlocked, false);
    await fs.writeFile(path.join(fixture.root, 'host-result.json'), JSON.stringify({ passed: true, suite: 'property-editing', vscode: vscode.version }));
  } finally { dom.close(); }
};
