const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const vscode = require("vscode");
const { connectWorkbench } = require("./query-constructor-dom.cjs");

/** Wait for native search and selection events, including asynchronous support paints. */
async function until(predicate, label) {
  const deadline = Date.now() + 15000;
  while (!await predicate()) {
    assert.ok(Date.now() < deadline, typeof label === "function" ? label() : label);
    await new Promise(resolve => setTimeout(resolve, 40));
  }
}

/** Clicking a native result expands its unopened ancestors and keeps the selected row after support paints. */
exports.run = async function () {
  const fixture = JSON.parse(process.env.ESKA_HOST_FIXTURE);
  await vscode.workspace.getConfiguration("eska.explorer").update("executable", process.env.ESKA_TEST_BINARY, vscode.ConfigurationTarget.Workspace);
  const explorer = await vscode.extensions.all.find(value => value.packageJSON.name === "eska-explorer").activate();
  await vscode.commands.executeCommand("eska.explorer.connect");
  assert.equal(explorer.connection.state.kind, "ready");
  await vscode.commands.executeCommand("eska.explorer.projects.focus");
  const workbench = await connectWorkbench(until);
  try {
    await vscode.commands.executeCommand("eska.explorer.search");
    const search = explorer.searchView;
    search.picker.ignoreFocusOut = true;
    search.picker.value = "Артикул";
    await until(() => !search.picker.busy && search.picker.items.some(item => item.hit), "search results loaded");
    let row;
    await until(async () => (row = await workbench.evaluate(`(() => {
      const row = [...document.querySelectorAll('.quick-input-widget .quick-input-list .monaco-list-row')]
        .find(node => node.textContent.includes('Артикул'));
      if (!row) return false;
      const rect = row.getBoundingClientRect();
      return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2, text: row.textContent };
    })()`)), "native result visible");
    const item = search.picker.items.find(item => item.hit && row.text.includes(item.detail));
    assert.ok(item, row.text);
    const expected = item.hit.objectId;
    await workbench.click(row.x, row.y);
    await until(() => !explorer.searchView && explorer.view.selection[0]?.node?.id.objectId === expected,
      () => JSON.stringify({ clicked: row.text, expected, selected: explorer.view.selection[0]?.node?.id,
        disposed: search.disposed, accepting: search.accepting, failure: search.failure }));
    // A support repaint of the revealed ancestry must retain its expanded state and selection.
    const selected = explorer.view.selection[0];
    const ancestors = [];
    for (let parent = explorer.tree.parent(selected); parent; parent = explorer.tree.parent(parent)) ancestors.push(parent);
    explorer.supportRepaint(ancestors);
    await new Promise(resolve => setTimeout(resolve, 500));
    assert.equal(explorer.view.selection[0]?.node?.id.objectId, expected);
    await vscode.commands.executeCommand("eska.explorer.disconnect");
    await fs.writeFile(path.join(fixture.root, "host-result.json"), JSON.stringify({ passed: true,
      suite: "search-click", vscode: vscode.version, locale: vscode.env.language }));
  } finally { workbench.close(); }
};
