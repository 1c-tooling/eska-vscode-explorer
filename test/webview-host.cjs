const fs = require('node:fs/promises');
const path = require('node:path');
const publications = new WeakMap();

/** Wait for a concrete context or DOM condition in the isolated native test window. */
async function until(condition, label) {
  for (let i = 0; i < 160; i++) { if (await condition()) return; await new Promise(resolve => setTimeout(resolve, 50)); }
  throw new Error(label);
}

/** Attach to a packaged webview by its visible title and retain screenshot evidence. */
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
    if (promise) { pending.delete(message.id); clearTimeout(promise.timer); message.error ? promise.reject(message.error) : promise.resolve(message.result); }
  });
  socket.addEventListener('close', () => {
    for (const value of pending.values()) { clearTimeout(value.timer); value.reject(new Error('native debug connection closed')); }
    pending.clear();
  });
  /** Match command replies independently of context notifications. */
  function send(method, params = {}, sessionId) {
    return new Promise((resolve, reject) => {
      const id = ++serial;
      // Hidden Windows webviews can suspend evaluation; they must not block discovery of the active frame.
      const timer = setTimeout(() => { pending.delete(id); reject(new Error(`native debug timeout: ${method}`)); }, 5000);
      pending.set(id, { resolve, reject, timer }); socket.send(JSON.stringify({ id, method, params, sessionId }));
    });
  }
  await send('Runtime.enable');
  const attached = new Set();
  let context;
  await until(async () => {
    const all = await send('Target.getTargets');
    for (const target of all.targetInfos.filter(item => item.type === 'iframe' && !attached.has(item.targetId))) {
      try {
        const { sessionId } = await send('Target.attachToTarget', { targetId: target.targetId, flatten: true });
        attached.add(target.targetId);
        await send('Runtime.enable', {}, sessionId);
      } catch (error) {
        // A newly shown Windows webview can replace its iframe between enumeration and attachment.
        attached.delete(target.targetId);
        if (!([-32000, -32001].includes(error?.code) && /(?:Session with given id not found|No target with given id found|No session with given id)/i.test(error.message))) throw error;
      }
    }
    for (const candidate of contexts) {
      try {
        const result = await send('Runtime.evaluate', { contextId: candidate.id, expression: `document.getElementById('title')?.textContent === ${JSON.stringify(tab.state.title)}`, returnByValue: true }, candidate.sessionId);
        if (result.result?.value) { context = candidate; return true; }
      } catch {}
    }
    return false;
  }, 'property frame');
  /** Observe only real state messages, after the packaged renderer has handled them. */
  function projectState(value) {
    return {revision:value.revision,status:value.status,editing:{busy:value.editing?.busy,unlocked:value.editing?.unlocked,
      blocked:value.editing?.blocked,drafts:value.editing?.drafts,snapshot:value.editing?.schema?.snapshot,undo:value.editing?.schema?.undo,redo:value.editing?.schema?.redo}};
  }
  const projection = projectState.toString();
  const propertyTab = Number.isInteger(tab.state?.revision) && typeof tab.receive === 'function';
  let publication = propertyTab ? publications.get(tab) : undefined;
  if (propertyTab && !publication) {
    publication = {sequence:0};
    publications.set(tab, publication);
    const publish = tab.publish.bind(tab), observed = publication;
    tab.publish = () => {
      publish();
      // A separate ignored marker acknowledges delivery without changing any product state.
      if (tab.ready && !tab.disposed) void tab.panel.webview.postMessage({type:'eska-native-publication',sequence:++observed.sequence});
    };
  }
  await send('Runtime.evaluate', {contextId:context.id,expression:`if(!globalThis.__eskaNativeObserver){globalThis.__eskaNativeObserver=true;
    window.addEventListener('message',event=>{if(event.data?.type==='state')globalThis.__eskaNativeState=event.data;
      if(event.data?.type==='eska-native-publication')globalThis.__eskaNativeSequence=event.data.sequence;});}`,returnByValue:true},context.sessionId);
  // Repeat the normal initial ready handshake only; subsequent waits observe production publications.
  if (propertyTab) await tab.receive({type:'ready'});
  async function currentState(idle) {
    if (!propertyTab) return;
    await until(async () => {
      const result = await send('Runtime.evaluate',{contextId:context.id,expression:`globalThis.__eskaNativeState&&({sequence:globalThis.__eskaNativeSequence,state:JSON.stringify((${projection})(globalThis.__eskaNativeState))})`,returnByValue:true},context.sessionId);
      const expected = projectState(tab.state), received = result.result?.value;
      return (!idle || (expected.status === 'ready' && !expected.editing.busy)) && received?.sequence >= publication.sequence && received.state === JSON.stringify(expected);
    },'current property state rendered');
  }
  await currentState(true);
  return {
    /** A file acknowledgement alone does not mean that the next control has been rendered. */
    async rendered() {
      await currentState(true);
    },
    /** Evaluate test code solely in this task's isolated property webview. */
    async evaluate(expression) {
      await currentState(false);
      const result = await send('Runtime.evaluate', { contextId: context.id, expression, returnByValue: true, awaitPromise: true }, context.sessionId);
      if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
      return result.result?.value;
    },
    /** Observe the native QuickPick outside the property iframe before sending keyboard commands. */
    async workbench(expression) {
      const result = await send('Runtime.evaluate', { expression, returnByValue: true });
      return result.result?.value;
    },
    /** Monaco list selection listens to pointer input rather than an HTMLElement.click shortcut. */
    async clickWorkbench(selector) {
      const result = await send('Runtime.evaluate', {expression:`(async()=>{
        const widget=[...document.querySelectorAll('.quick-input-widget')].find(node=>node.offsetWidth&&node.offsetHeight);
        if(widget)await Promise.allSettled(document.getAnimations().filter(animation=>animation.effect?.target instanceof Element
          &&(animation.effect.target===widget||widget.contains(animation.effect.target))).map(animation=>animation.finished));
        for(const element of document.querySelectorAll(${JSON.stringify(selector)})){
          const rect=element.getBoundingClientRect();if(!rect.width||!rect.height)continue;
          const point={x:rect.x+rect.width/2,y:rect.y+rect.height/2},hit=document.elementFromPoint(point.x,point.y);
          if(hit&&(hit===element||element.contains(hit)))return point;
        }})()`,returnByValue:true,awaitPromise:true});
      const point = result.result?.value;
      if (!point) throw new Error(`missing native control: ${selector}`);
      await send('Input.dispatchMouseEvent', {type:'mousePressed',...point,button:'left',clickCount:1});
      await send('Input.dispatchMouseEvent', {type:'mouseReleased',...point,button:'left',clickCount:1});
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

exports.frame = frame;
exports.until = until;
