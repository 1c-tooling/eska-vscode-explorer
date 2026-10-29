const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const vscode = require("vscode");
const { connectWorkbench } = require("./query-constructor-dom.cjs");

/** Native status checks wait for actual component probes, never for a release response. */
async function until(predicate, label) {
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) { if (await predicate()) return; await new Promise(resolve => setTimeout(resolve, 40)); }
  throw new Error(label);
}

/** The one ESKA item exposes independent component versions and commands through native Quick Picks. */
exports.run = async function () {
  const fixture = JSON.parse(process.env.ESKA_HOST_FIXTURE), calls = [];
  let explorer, workbench;
  try {
    const extension = vscode.extensions.all.find(value => value.packageJSON.name === "eska-explorer");
    explorer = await extension.activate();
    await until(() => explorer.connection.state.kind === "ready", "project connected");
    await until(() => !!explorer.tooling.states.analyzer.info, "Analyzer binary verified");
    await explorer.tooling.ensureFormatter(undefined, false);
    const project = explorer.status;
    assert.equal(project.text, `ESKA v${explorer.connection.state.version}`);
    assert.equal(project.command, "eska.explorer.updateTools");
    assert.equal("analyzerStatus" in explorer.tooling, false);
    assert.equal("formatterStatus" in explorer.tooling, false);
    for (const kind of ["project", "formatter", "analyzer"]) {
      assert.ok(project.tooltip.includes(explorer.tooling.states[kind].info.path));
    }
    workbench = await connectWorkbench(until);
    const update = explorer.tooling.updateAll;
    let updated = 0;
    explorer.tooling.updateAll = async () => { updated++; };
    try {
      const button = await workbench.evaluate(`(() => {
        const node = document.querySelector('.statusbar-item[id$="eska.explorer.connection"]');
        const rect = node.getBoundingClientRect();
        return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
      })()`);
      await workbench.click(button.x, button.y);
      await until(() => updated === 1, "native status click starts the complete update");
    }
    finally { explorer.tooling.updateAll = update; }
    assert.equal(updated, 1, "status invokes all components without opening a picker");
    assert.equal(await workbench.evaluate('[...document.querySelectorAll(".quick-input-widget")].some(node => node.offsetParent !== null)'), false);
    const footer = await workbench.evaluate(`[...document.querySelectorAll(".statusbar-item")].filter(node => /eska\\.explorer\\.(connection|analyzer|formatter)$/.test(node.id)).map(node => ({id:node.id,text:node.textContent.trim()}))`);
    assert.equal(footer.length, 1); assert.ok(footer[0].id.endsWith("eska.explorer.connection"));
    const names = ["eska-project", "eska-fmt", "bsl-analyzer-app"];
    const check = explorer.tooling.check;
    explorer.tooling.check = async (kind, manual = true) => { calls.push([kind, manual]); };
    try {
      for (const [index, kind] of ["project", "formatter", "analyzer"].entries()) {
        const job = vscode.commands.executeCommand("eska.explorer.components");
        await until(async () => await workbench.evaluate('document.querySelector(".quick-input-title")?.textContent === "ESKA"'), "component list opened");
        const rows = await workbench.evaluate('[...document.querySelectorAll(".quick-input-widget .quick-input-list .monaco-list-row")].map(node => node.textContent)');
        assert.equal(rows.length, 3);
        names.forEach((name, at) => assert.ok(rows[at].includes(name), rows));
        if (process.env.ESKA_HOST_DOM_ARTIFACTS && index === 1) {
          await fs.mkdir(process.env.ESKA_HOST_DOM_ARTIFACTS, {recursive:true});
          await workbench.screenshot(path.join(process.env.ESKA_HOST_DOM_ARTIFACTS, `components-${vscode.env.language}.png`));
        }
        for (let move = 0; move < index; move++) await vscode.commands.executeCommand("workbench.action.quickOpenSelectNext");
        await vscode.commands.executeCommand("workbench.action.acceptSelectedQuickOpenItem");
        await until(async () => await workbench.evaluate(`document.querySelector(".quick-input-title")?.textContent === ${JSON.stringify(`ESKA › ${names[index]}`)}`), "component actions opened");
        await vscode.commands.executeCommand("workbench.action.acceptSelectedQuickOpenItem");
        await job; assert.deepEqual(calls.at(-1), [kind, true]);
      }
    } finally { explorer.tooling.check = check; }
    const readyText = project.text;
    explorer.tooling.analyzerState("error", "injected-language-failure");
    assert.equal(project.text, readyText);
    assert.ok(project.tooltip.includes("injected-language-failure"));
    assert.ok((await explorer.getChildren()).some(entry => entry.node), "metadata remains available");
    explorer.tooling.analyzerState("suspended", "injected-conflict");
    await vscode.commands.executeCommand("eska.explorer.disconnect");
    assert.match(project.text, /^ESKA · /);
    assert.equal(explorer.tooling.states.analyzer.phase, "suspended");
    await fs.writeFile(path.join(fixture.root, "host-result.json"), JSON.stringify({ passed: true, suite: "tool-status", locale:vscode.env.language,
      vscode: vscode.version, footer, menuComponents:names, commands:calls }));
  } catch (error) {
    const ui = await workbench?.evaluate('({title:document.querySelector(".quick-input-title")?.textContent,rows:[...document.querySelectorAll(".quick-input-widget .monaco-list-row")].map(node=>node.textContent)})').catch(() => undefined);
    await fs.writeFile(path.join(fixture.root, "host-result.json"), JSON.stringify({passed:false,suite:"tool-status",error:String(error.stack ?? error),ui})); throw error;
  } finally { workbench?.close(); await explorer?.shutdown(); }
};
