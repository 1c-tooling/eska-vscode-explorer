const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const vscode = require("vscode");

/** Wait for the selected real analyzer context and exact metadata completion. */
async function until(action, label) {
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    try { const result = await action(); if (result) return result; } catch {}
    await new Promise(resolve => setTimeout(resolve, 70));
  }
  throw new Error(label);
}

/** Query opening is the same public command in either workspace member. */
async function open(file) {
  const owner = await vscode.workspace.openTextDocument(vscode.Uri.file(file)), editor = await vscode.window.showTextDocument(owner, { preview: false });
  const at = owner.positionAt(owner.getText().indexOf("SELECT ") + 2); editor.selection = new vscode.Selection(at, at);
  await vscode.commands.executeCommand("eska.explorer.editBslQuery");
  return until(() => vscode.window.activeTextEditor?.document.uri.scheme === "eska-query" && vscode.window.activeTextEditor.document, "application query opened");
}

/** Native completion must contain only the selected application's distinct field. */
async function labels(document) {
  const point = document.positionAt(document.getText().indexOf("Товар.Only") + "Товар.Only".length);
  const value = await vscode.commands.executeCommand("vscode.executeCompletionItemProvider", document.uri, point);
  return value?.items.map(item => typeof item.label === "string" ? item.label : item.label.label) ?? [];
}

/** Context replacement preserves an earlier application's draft and cannot lend it another application's resolver. */
exports.run = async function () {
  const fixture = JSON.parse(process.env.ESKA_HOST_FIXTURE), accepted = [];
  let explorer;
  try {
    explorer = await vscode.extensions.all.find(value => value.packageJSON.name === "eska-explorer").activate();
    await until(() => explorer.tree && explorer.connection.state.kind === "ready" && !explorer.support.loading, "workspace metadata ready");
    const first = await open(fixture.applications.one.module);
    await until(async () => (await labels(first)).includes("OnlyFirst"), "first application metadata");
    assert.equal((await labels(first)).includes("OnlySecond"), false);
    const original = first.getText(), pid = explorer.language.session.owner.child.pid;
    accepted.push("first_application_query_resolves_only_its_own_metadata");
    // Select through the production controller; the text input itself is not under test.
    await explorer.language.restart(true, "two", true);
    await until(() => explorer.tooling.states.analyzer.phase === "ready" && explorer.language.selectedApplication === "two", "second application ready");
    assert.notEqual(explorer.language.session.owner.child.pid, pid);
    assert.equal(first.getText(), original);
    assert.equal((await labels(first)).some(label => ["OnlyFirst", "OnlySecond"].includes(label)), false);
    accepted.push("switching_application_pauses_earlier_query_without_lending_other_context");
    const second = await open(fixture.applications.two.module);
    await until(async () => (await labels(second)).includes("OnlySecond"), "second application metadata");
    assert.equal((await labels(second)).includes("OnlyFirst"), false);
    assert.equal(first.getText(), original);
    accepted.push("second_application_query_resolves_only_its_own_metadata");
    await vscode.commands.executeCommand("eska.explorer.cancelQuery", second.uri);
    await vscode.commands.executeCommand("eska.explorer.cancelQuery", first.uri);
    await fs.writeFile(path.join(fixture.root, "host-result.json"), JSON.stringify({ passed: true, suite: "query-language-context", accepted }));
  } catch (error) {
    await fs.writeFile(path.join(fixture.root, "host-result.json"), JSON.stringify({ passed: false, accepted,
      states: explorer ? [...explorer.language.queryLanguage.states.values()] : [], connection: explorer?.connection.state,
      error: String(error.stack ?? error) })); throw error;
  }
};
