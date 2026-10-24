const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');

/** Inspect only the disposable test window's explicitly enabled Chromium endpoint. */
async function attach(target) {
  const socket = new WebSocket(target.webSocketDebuggerUrl), pending = new Map(), contexts = new Set(); let serial = 0;
  await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
  socket.onmessage = event => {
    const value = JSON.parse(event.data);
    if (value.method === 'Runtime.executionContextCreated') contexts.add(value.params.context.id);
    if (value.method === 'Runtime.executionContextDestroyed') contexts.delete(value.params.executionContextId);
    if (value.id && pending.has(value.id)) { const request = pending.get(value.id); pending.delete(value.id); clearTimeout(request.timer); value.error ? request.reject(new Error(JSON.stringify(value.error))) : request.resolve(value.result); }
  };
  const request = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++serial, timer = setTimeout(() => { pending.delete(id); reject(new Error(method + ' deadline')); }, 10000);
    pending.set(id, { resolve, reject, timer }); socket.send(JSON.stringify({ id, method, params }));
  });
  try { await request('Runtime.enable'); } catch (error) { socket.close(); throw error; }
  return { request, contexts, close: () => socket.close() };
}

/** A visible webview frame is located by its own DOM, rather than inferred from a tab title. */
exports.connect = async function (until) {
  const port = Number(process.env.ESKA_HOST_DEBUG_PORT); assert.ok(port > 0);
  const connections = new Map(); let found;
  await until(async () => {
    const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
    for (const target of targets) if (["page", "iframe"].includes(target.type) && target.webSocketDebuggerUrl && !connections.has(target.id)) {
      try { connections.set(target.id, await attach(target)); }
      catch (error) { throw new Error(`${target.type} ${target.url}: ${error.message}`); }
    }
    for (const connection of connections.values()) for (const contextId of connection.contexts) {
      const result = await connection.request('Runtime.evaluate', { contextId, expression: '!!document.getElementById("root")?.querySelector(".sections")', returnByValue: true }).catch(() => undefined);
      if (result?.result.value === true) { found = { connection, contextId }; return true; }
    }
    return false;
  }, 'visible constructor DOM');
  const evaluate = async expression => {
    const value = await found.connection.request('Runtime.evaluate', { contextId: found.contextId, expression, returnByValue: true, awaitPromise: true });
    if (value.exceptionDetails) throw new Error(JSON.stringify(value.exceptionDetails)); return value.result.value;
  };
  return { evaluate, close: () => { for (const connection of connections.values()) connection.close(); },
    screenshot: async file => {
      const [connection] = connections.values(); await connection.request('Page.enable');
      const image = await connection.request('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
      await fs.writeFile(file, Buffer.from(image.data, 'base64'));
    } };
};

/** Real DOM clicks traverse the installed renderer, webview message transport and production controller into ESKA. */
exports.exercise = async function ({ explorer, view, until, locale }) {
  const client = await exports.connect(until);
  try {
    assert.equal(await client.evaluate('document.querySelectorAll(".sections > section").length'), 6);
    assert.equal(await client.evaluate('document.querySelector("header button").textContent'), locale === 'ru' ? 'Применить к черновику' : 'Apply to draft');
    assert.equal(await client.evaluate('document.querySelectorAll("#root img, #root script").length'), 0);
    assert.equal(await client.evaluate('globalThis.queryExecuted === true'), false);
    assert.equal(await client.evaluate('document.body.scrollWidth <= innerWidth'), true);
    const before = view.binding.core.model.revision;
    await client.evaluate('document.querySelector(".sections > section .section-title button").click()');
    await client.evaluate('document.querySelector("textarea").value = "99 AS BrowserField"; document.querySelector(".expression button").click()');
    await until(() => view.binding.core.model.revision !== before && !view.busy, 'DOM expression reached ESKA');
    await until(async () => await client.evaluate('document.querySelector(".sections > section").textContent.includes("99 AS BrowserField")'), 'acknowledged DOM row');
    assert.equal(await client.evaluate('document.querySelectorAll("#root img").length'), 0);
    const stand = process.env.ESKA_HOST_DOM_ARTIFACTS;
    if (stand) { await fs.mkdir(stand, { recursive: true }); await client.screenshot(path.join(stand, `constructor-${locale}.png`)); }
    await client.evaluate('document.querySelectorAll("header button")[1].click()');
    await until(() => view.ending && !explorer.queryDesigner.views.size, 'DOM cancellation returned to draft');
    return 'installed_webview_dom_six_sections_translated_labels_text_only_rendering_expression_submission_and_cancel';
  } finally { client.close(); }
};
