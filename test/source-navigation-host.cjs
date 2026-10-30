const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const vscode = require("vscode");

/** Observe native selection asynchronously without modifying the tree provider or editor behavior. */
async function until(predicate, message) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 40));
  }
  throw new Error(message);
}

/** The public reverse-navigation command preserves a dirty buffer and selects the backend-owned module. */
exports.run = async function () {
  const fixture = JSON.parse(process.env.ESKA_HOST_FIXTURE);
  const extension = vscode.extensions.all.find(value => value.packageJSON.name === "eska-explorer");
  await vscode.workspace.getConfiguration("eska.explorer").update("executable", process.env.ESKA_TEST_BINARY, vscode.ConfigurationTarget.Workspace);
  const explorer = await extension.activate();
  await vscode.commands.executeCommand("eska.explorer.disconnect");
  await vscode.commands.executeCommand("eska.explorer.connect");
  await until(() => explorer.connection.state.kind === "ready" && !explorer.support.loading, "backend ready");
  assert.equal(explorer.connection.state.sourceNavigation, true);
  const original = await fs.readFile(fixture.module);
  const document = await vscode.workspace.openTextDocument(vscode.Uri.file(fixture.module));
  const editor = await vscode.window.showTextDocument(document);
  assert.equal(await editor.edit(edit => edit.insert(new vscode.Position(0, 0), "// unsaved navigation\n")), true);
  const dirty = document.getText(), version = document.version;
  const methods = [];
  const events = [];
  const visibility = explorer.view.onDidChangeVisibility(event => events.push({ visible: event.visible, time: performance.now() }));
  const refreshes = explorer.changed.event(entry => events.push({ refresh: entry?.key ?? "roots", time: performance.now() }));
  const selections = explorer.view.onDidChangeSelection(event => events.push({ selection: event.selection.map(row => row.key), time: performance.now() }));
  const errors = [];
  const showError = explorer.showError.bind(explorer);
  explorer.showError = error => { errors.push({code:error.code,domain:error.domain,details:error.details}); showError(error); };
  const request = explorer.connection.request.bind(explorer.connection);
  explorer.connection.request = (session, method, ...args) => {
    methods.push(method);
    const time = performance.now(), pending = request(session, method, ...args);
    void pending.then(() => events.push({ method, elapsed: performance.now() - time }), error => events.push({ method, error: String(error) }));
    return pending;
  };
  const started = performance.now();
  await vscode.commands.executeCommand("eska.explorer.revealActiveFile");
  try { await until(() => explorer.view.selection[0]?.node?.id.kind === "module", "native tree selected the module"); }
  catch (error) {
    await fs.writeFile(path.join(fixture.root, "host-result.json"), JSON.stringify({ passed: false,
      error: String(error.stack ?? error), methods, errors, events, visible: explorer.view.visible,
      roots: explorer.tree.projects.map(project => ({ dirty: project.rootDirty, nodes: project.nodes.size,
        children: project.root?.children?.map(row => row.node.id) })),
      connection: explorer.connection.state.kind,
      selection: explorer.view.selection.map(row => ({ key: row.key, node: row.node?.id })),
      active: vscode.window.activeTextEditor?.document.uri.toString() }));
    throw error;
  } finally {
    visibility.dispose();
    refreshes.dispose();
    selections.dispose();
  }
  const elapsedMs = performance.now() - started;
  assert.equal(explorer.view.selection[0].node.id.role, "object");
  assert.equal(methods.filter(method => method === "metadata/revealSource").length, 1);
  assert.equal(methods.includes("metadata/source"), false, "navigation does not probe sibling sources");
  assert.equal(document.getText(), dirty);
  assert.equal(document.version, version);
  assert.equal(document.isDirty, true);
  assert.deepEqual(await fs.readFile(fixture.module), original);
  const project = explorer.tree.projects[0];
  const progress = await explorer.tree.request(project, "metadata/index", { action: "status" });
  assert.equal(progress.progress.state, "not_started");
  explorer.connection.request = request;
  await vscode.window.showTextDocument(document);
  await vscode.commands.executeCommand("workbench.action.revertAndCloseActiveEditor");
  await vscode.commands.executeCommand("eska.explorer.disconnect");
  await fs.writeFile(path.join(fixture.root, "host-result.json"), JSON.stringify({ passed: true,
    suite: "source-navigation", projectType: fixture.type ?? process.env.ESKA_HOST_PROJECT_TYPE ?? "configuration",
    vscode: vscode.version, locale: vscode.env.language, elapsedMs, methods }));
};
