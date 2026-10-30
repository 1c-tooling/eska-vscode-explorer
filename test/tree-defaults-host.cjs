const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const vscode = require("vscode");

/** Wait for the native tree to finish handling a collapse event. */
async function until(predicate) {
  const deadline = Date.now() + 15000;
  while (!predicate()) {
    assert.ok(Date.now() < deadline, "native tree updated");
    await new Promise(resolve => setTimeout(resolve, 40));
  }
}

/** Single projects expand initially; workspace members and explicit user collapses stay collapsed. */
exports.run = async function () {
  const fixture = JSON.parse(process.env.ESKA_HOST_FIXTURE);
  const { createTreeProject } = await import("./fixture.mjs");
  await vscode.workspace.getConfiguration("eska.explorer").update("executable", process.env.ESKA_TEST_BINARY, vscode.ConfigurationTarget.Workspace);
  const explorer = await vscode.extensions.all.find(value => value.packageJSON.name === "eska-explorer").activate();
  const manifest = path.join(fixture.root, "eska.toml");
  for (const type of ["configuration", "extension", "report", "processing"]) {
    await vscode.commands.executeCommand("eska.explorer.disconnect");
    const project = await createTreeProject(path.join(fixture.root, type), type);
    const projectManifest = (await fs.readFile(path.join(project.root, "eska.toml"), "utf8")).replace("tree-test", type);
    await fs.writeFile(path.join(project.root, "eska.toml"), projectManifest);
    await fs.writeFile(manifest, projectManifest + `source='${type}/src'\n`);
    await vscode.commands.executeCommand("eska.explorer.connect");
    assert.equal(explorer.connection.state.kind, "ready", JSON.stringify(explorer.connection.state));
    const root = (await explorer.getChildren()).find(row => row.node);
    assert.ok(root, type);
    assert.equal(root.project.info.scope.kind, "standalone");
    assert.equal(explorer.getTreeItem(root).collapsibleState, vscode.TreeItemCollapsibleState.Expanded, type);
    if (type === "report" || type === "processing") {
      const children = await explorer.getChildren(root);
      assert.equal(children[0].node.id.kind, "module");
      assert.equal(children[0].node.id.role, "object");
      assert.equal(explorer.getParent(children[0]), root);
      assert.ok(!children.some(row => row.node?.id.collection?.kind === "modules"));
    }
  }
  await vscode.commands.executeCommand("eska.explorer.projects.focus");
  const root = (await explorer.getChildren()).find(row => row.node);
  await explorer.expandRootForReveal(explorer.tree, root.project);
  await explorer.view.reveal(root, { select: true, focus: true, expand: true });
  await until(() => explorer.view.selection[0] === root);
  await vscode.commands.executeCommand("list.collapse");
  await until(() => explorer.getTreeItem(root).collapsibleState === vscode.TreeItemCollapsibleState.Collapsed);
  await vscode.commands.executeCommand("eska.explorer.refresh");
  assert.equal(explorer.getTreeItem(root).collapsibleState, vscode.TreeItemCollapsibleState.Collapsed);
  for (const members of ["[workspace.members.app]\nconfiguration='configuration'\n",
    "[workspace.members.app]\nconfiguration='configuration'\nexternal_objects=['report']\n"]) {
    await vscode.commands.executeCommand("eska.explorer.disconnect");
    await fs.writeFile(manifest, "[workspace]\n" + members);
    await vscode.commands.executeCommand("eska.explorer.connect");
    assert.equal(explorer.connection.state.kind, "ready", JSON.stringify(explorer.connection.state));
    const projects = (await explorer.getChildren()).filter(row => row.node);
    assert.equal(projects.length, members.includes("external_objects") ? 2 : 1);
    for (const row of projects) {
      assert.equal(row.project.info.scope.kind, "member");
      assert.equal(explorer.getTreeItem(row).collapsibleState, vscode.TreeItemCollapsibleState.Collapsed);
    }
  }
  await vscode.commands.executeCommand("eska.explorer.disconnect");
  await fs.writeFile(path.join(fixture.root, "host-result.json"), JSON.stringify({ passed: true,
    suite: "tree-defaults", vscode: vscode.version, locale: vscode.env.language }));
};
