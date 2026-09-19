const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const vscode = require("vscode");
const execute = require("node:util").promisify(require("node:child_process").execFile);

/** Wait for native filesystem/selection events rather than assuming synchronous delivery. */
async function until(predicate, reason) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  assert.fail(reason);
}

/** Exercise global/member files and metadata in one native tree, including reconnect and file watches. */
exports.run = async function () {
  const fixture = JSON.parse(process.env.ESKA_HOST_FIXTURE);
  const { createTreeProject } = await import("./fixture.mjs");
  await fs.rm(fixture.source, { recursive: true });
  const first = await createTreeProject(path.join(fixture.root, "src/first"));
  const second = await createTreeProject(path.join(fixture.root, "src/second"), "processing");
  for (const member of [first, second]) {
    const manifest = path.join(member.root, "eska.toml");
    await fs.writeFile(manifest, (await fs.readFile(manifest, "utf8")).replace("tree-test", path.basename(member.root)));
  }
  await fs.writeFile(path.join(fixture.root, "eska.toml"), "[workspace]\nmembers=['src/first','src/second']\n");
  await fs.writeFile(path.join(fixture.root, "README.md"), "# Workspace\n");
  await fs.writeFile(path.join(fixture.root, "bsl-analyzer.toml"), "# settings\n");
  await fs.writeFile(path.join(first.root, "README.ru.md"), "# Первый\n");
  await fs.writeFile(path.join(first.root, ".gitignore"), "build/\n");
  await fs.mkdir(path.join(fixture.root, "build"));
  await fs.writeFile(path.join(fixture.root, "build/demo.cf"), "test artifact, not a real configuration");
  await fs.mkdir(path.join(fixture.root, ".hidden"));
  await fs.writeFile(path.join(fixture.root, ".hidden/config"), "hidden\n");
  // Two real Git branches exercise external checkout events without touching any user repository.
  const git = (...args) => execute("git", args, { cwd: fixture.root });
  await git("init", "-b", "review-a");
  await git("config", "user.name", "Explorer Review");
  await git("config", "user.email", "review@example.invalid");
  await git("add", ".");
  await git("commit", "-m", "test: branch A");
  await git("switch", "-c", "review-b");
  await fs.writeFile(first.descriptor, (await fs.readFile(first.descriptor, "utf8")).replace("<Name>Артикул</Name>", "<Name>ДругаяВетка</Name>"));
  await git("commit", "-am", "test: branch B");
  await git("switch", "review-a");
  const config = vscode.workspace.getConfiguration("eska.explorer");
  await config.update("executable", process.env.ESKA_TEST_BINARY, vscode.ConfigurationTarget.Workspace);
  await config.update("treeLanguage", "ru-RU", vscode.ConfigurationTarget.Workspace);
  const explorer = await vscode.extensions.all.find(value => value.packageJSON.name === "eska-explorer").activate();
  await vscode.commands.executeCommand("eska.explorer.connect");
  await vscode.commands.executeCommand("eska.explorer.projects.focus");
  const rows = await explorer.getChildren();
  assert.ok(rows.every(row => row.fileKind !== "workspace"), "no synthetic workspace parent");
  const projects = rows.filter(row => row.node);
  assert.equal(projects.length, 2);
  assert.ok(rows.some(row => row.kind === "settings"));
  const otherFiles = await explorer.getChildren(rows.find(row => row.kind === "other"));
  assert.ok(!otherFiles.some(row => row.path === path.join(fixture.root, "src")), "member-only src is hidden");
  const root = projects[0];
  // Match members by their authoritative physical paths.
  const firstRoot = projects.find(row => row.project.info.rootPath.value === first.root);
  assert.ok(firstRoot);
  assert.equal(explorer.getParent(firstRoot), undefined);
  const sections = await explorer.getChildren(firstRoot);
  const groups = sections.filter(row => row.fileKind === "group");
  assert.deepEqual(groups.map(row => row.kind), ["settings", "documentation", "other"]);
  assert.equal(explorer.getTreeItem(groups[0]).label, "Настройки проекта");
  const catalogs = sections.find(row => row.node?.id.collection?.metadataKind === "catalog");
  assert.equal(explorer.getParent(catalogs), firstRoot);
  assert.equal(explorer.getParent(groups[0]), firstRoot);
  assert.ok(sections.indexOf(catalogs) < sections.indexOf(groups[0]), "metadata precedes file groups");
  for (const group of rows.filter(row => row.fileKind === "group")) assert.equal(explorer.getParent(group), undefined);
  await explorer.view.reveal(catalogs, { select: true, focus: true });
  try { await until(() => explorer.view.selection[0]?.key === catalogs.key, "metadata is directly inside the configuration"); }
  catch (error) { throw new Error(`${error.message}: ${JSON.stringify({ selected: explorer.view.selection.map(row => row.key),
    expected: catalogs.key, expanded: [...explorer.expanded.entries()], session: explorer.connection.state.kind })}`); }
  for (const file of [path.join(first.root, "eska.toml"), path.join(first.root, ".gitignore"),
    path.join(first.root, "README.ru.md"), path.join(fixture.root, "README.md"),
    path.join(fixture.root, "bsl-analyzer.toml"), path.join(fixture.root, "build/demo.cf"),
    path.join(fixture.root, ".hidden/config")]) {
    const entry = await explorer.files.reveal(file);
    assert.ok(entry, file);
    const item = explorer.getTreeItem(entry);
    assert.equal(item.label, path.basename(file));
    assert.equal(item.resourceUri.fsPath, file);
    await vscode.commands.executeCommand(item.command.command, ...item.command.arguments);
    assert.equal(vscode.window.activeTextEditor.document.uri.fsPath, file);
    await vscode.commands.executeCommand("eska.explorer.revealActiveFile");
    await until(() => explorer.view.selection[0]?.path === file, `reveal ${file}`);
  }
  const tree = explorer.tree;
  const secondRoot = projects.find(row => row !== firstRoot);
  assert.ok(!(await explorer.getChildren(secondRoot)).some(row => row.kind === "documentation"));
  const readme = path.join(secondRoot.project.info.rootPath.value, "README.en.md");
  await fs.writeFile(readme, "# Newly added\n");
  await until(async () => (await explorer.getChildren(secondRoot)).some(row => row.kind === "documentation"), "new README creates group");
  await fs.rm(readme);
  await until(async () => !(await explorer.getChildren(secondRoot)).some(row => row.kind === "documentation"), "deleted README removes group");
  assert.equal(explorer.tree, tree, "ordinary file changes do not restart metadata backend");
  const secondGeneration = secondRoot.project.info.generation;
  const secondChildren = secondRoot.children;
  const pid = explorer.connection.child.pid;
  const goods = (await tree.children(catalogs)).find(entry => entry.node.label.text === "Товары");
  assert.ok(goods);
  await tree.request(firstRoot.project, "metadata/index", { action: "start" });
  for (let round = 0; round < 6; round++) {
    const name = round % 2 ? "Артикул" : "ДругаяВетка";
    const previous = firstRoot.project.info.generation;
    await git("switch", round % 2 ? "review-a" : "review-b");
    await until(() => firstRoot.project.info.generation !== previous, "checkout invalidates first member");
    const attributes = (await tree.children(goods)).find(entry => entry.node.id.collection?.metadataKind === "attribute");
    assert.deepEqual((await tree.children(attributes)).map(entry => entry.node.label.text), [name]);
    await until(async () => (await tree.request(firstRoot.project, "metadata/search", { text: name, limit: 50 })).hits.some(hit => hit.name === name), "search follows branch switch");
    const stale = await tree.request(firstRoot.project, "metadata/search", { text: round % 2 ? "ДругаяВетка" : "Артикул", limit: 50 });
    assert.ok(!stale.hits.some(hit => hit.ancestry.some(node => node.objectId === goods.node.id.objectId)), "old owner results removed");
    assert.equal(secondRoot.project.info.generation, secondGeneration);
    assert.equal(secondRoot.children, secondChildren);
    assert.equal(explorer.connection.child.pid, pid);
  }
  await config.update("treeLanguage", "en-US", vscode.ConfigurationTarget.Workspace);
  await until(() => explorer.getTreeItem(groups[0]).label === "Project settings", "file groups use tree language");
  await vscode.commands.executeCommand("eska.explorer.showEmptyGroups", root);
  await vscode.commands.executeCommand("eska.explorer.hideEmptyGroups", root);
  await vscode.commands.executeCommand("eska.explorer.refresh");
  await vscode.commands.executeCommand("eska.explorer.restart");
  const freshRows = await explorer.getChildren();
  assert.deepEqual(freshRows.map(row => row.key), rows.map(row => row.key));
  const finalPid = explorer.connection.child.pid;
  await vscode.commands.executeCommand("eska.explorer.disconnect");
  assert.throws(() => process.kill(finalPid, 0), { code: "ESRCH" });
  assert.equal(explorer.files, undefined);
  assert.equal(explorer.connection.child, undefined);
  assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
  await fs.writeFile(path.join(fixture.root, "host-result.json"), JSON.stringify({ passed: true, vscode: vscode.version, suite: "workspace" }));
};
