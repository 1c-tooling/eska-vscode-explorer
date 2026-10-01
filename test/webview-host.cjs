const fs = require('node:fs/promises');
const path = require('node:path');

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
    if (promise) { pending.delete(message.id); message.error ? promise.reject(message.error) : promise.resolve(message.result); }
  });
  /** Match command replies independently of context notifications. */
  function send(method, params = {}, sessionId) {
    return new Promise((resolve, reject) => { const id = ++serial; pending.set(id, { resolve, reject }); socket.send(JSON.stringify({ id, method, params, sessionId })); });
  }
  await send('Runtime.enable');
  const attached = new Set();
  let context;
  await until(async () => {
    const all = await send('Target.getTargets');
    for (const target of all.targetInfos.filter(item => item.type === 'iframe' && !attached.has(item.targetId))) {
      const { sessionId } = await send('Target.attachToTarget', { targetId: target.targetId, flatten: true });
      attached.add(target.targetId);
      await send('Runtime.enable', {}, sessionId);
    }
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
    /** Observe the native QuickPick outside the property iframe before sending keyboard commands. */
    async workbench(expression) {
      const result = await send('Runtime.evaluate', { expression, returnByValue: true });
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

exports.frame = frame;
exports.until = until;
