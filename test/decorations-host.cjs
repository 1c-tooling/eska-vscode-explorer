const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const { promisify } = require("node:util");
const exec = promisify(require("node:child_process").execFile);
const vscode = require("vscode");

/** Wait for Git snapshots and metadata watchers rather than relying on an arbitrary delay. */
async function until(predicate, reason) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  assert.fail(reason);
}

/** Validate status decorations against the built-in Git extension and a disposable repository. */
exports.run = async function () {
  const fixture = JSON.parse(process.env.ESKA_HOST_FIXTURE);
  /** Git commands operate only on this test's unique repository. */
  const git = (...args) => exec("git", args, { cwd: fixture.root });
  await fs.writeFile(path.join(fixture.root, ".gitignore"), ".eska/\n.vscode/\n");
  const { descriptor } = await import("./fixture.mjs");
  await fs.writeFile(fixture.descriptor, descriptor("Catalog", "Товары", "<Form>Форма</Form>"));
  const formDir = path.join(fixture.source, "Catalogs/Товары/Forms/Форма/Ext");
  await fs.mkdir(path.join(formDir, "Form"), { recursive: true });
  await fs.writeFile(path.join(formDir, "../../Форма.xml"), descriptor("Form", "Форма"));
  await fs.writeFile(path.join(formDir, "Form.xml"), "<Form/>\n");
  const formModule = path.join(formDir, "Form/Module.bsl");
  await fs.writeFile(formModule, "// form\n");
  await git("init");
  await git("config", "user.name", "Explorer Test");
  await git("config", "user.email", "explorer@example.invalid");
  await git("add", ".");
  await git("commit", "-m", "test fixture");
  await vscode.workspace.getConfiguration("eska.explorer").update("executable", process.env.ESKA_TEST_BINARY, vscode.ConfigurationTarget.Workspace);
  const api = (await vscode.extensions.getExtension("vscode.git").activate()).getAPI(1);
  const repository = await api.openRepository(vscode.Uri.file(fixture.root));
  assert.ok(repository);
  const explorer = await vscode.extensions.all.find(value => value.packageJSON.name === "eska-explorer").activate();
  await vscode.commands.executeCommand("eska.explorer.connect");
  /** Resolve a status through the same provider used by the native renderer. */
  const decoration = entry => explorer.decorations.provideFileDecoration(explorer.getTreeItem(entry).resourceUri);
  const [root] = await explorer.getChildren();
  const catalogs = (await explorer.getChildren(root)).find(entry => entry.node?.id.collection?.metadataKind === "catalog");
  const objects = await explorer.getChildren(catalogs);
  const owner = objects.find(entry => entry.node.label.text === "Товары");
  const clean = objects.find(entry => entry.node.label.text === "Покупатели");
  const groups = await explorer.getChildren(owner);
  const modules = groups.find(entry => entry.node?.id.collection?.kind === "modules");
  const [module] = await explorer.getChildren(modules);
  await repository.status();
  assert.equal(await decoration(module), undefined);
  await fs.appendFile(fixture.module, "// changed\n");
  await repository.status();
  await until(async () => (await decoration(module))?.badge === "M", "modified module");
  assert.equal((await decoration(module)).color.id, "gitDecoration.modifiedResourceForeground");
  assert.ok(await decoration(owner));
  assert.equal((await decoration(catalogs)).badge, "•");
  assert.equal((await decoration(root)).badge, "•");
  assert.equal(await decoration(clean), undefined);
  await git("add", fixture.module);
  await repository.status();
  await until(async () => (await decoration(module))?.color.id === "gitDecoration.stageModifiedResourceForeground", "staged module");
  await git("commit", "-m", "changed module");
  await repository.status();
  await until(async () => await decoration(module) === undefined, "clean module after commit");
  const manager = path.join(path.dirname(fixture.module), "ManagerModule.bsl");
  await fs.writeFile(manager, "// new manager\n");
  await repository.status();
  let managerEntry;
  await until(async () => {
    const current = (await explorer.getChildren(owner)).find(entry => entry.node?.id.collection?.kind === "modules");
    const rows = current ? await explorer.getChildren(current) : [];
    managerEntry = rows.find(entry => entry.node?.id.role === "manager");
    return managerEntry && (await decoration(managerEntry))?.badge === "U";
  }, "new untracked module");
  const forms = (await explorer.getChildren(owner)).find(entry => entry.node?.id.collection?.metadataKind === "form");
  const [form] = await explorer.getChildren(forms);
  const formRows = await explorer.getChildren(form);
  await fs.appendFile(formModule, "// modified form\n");
  await repository.status();
  const codeRow = formRows.find(row => row.target === "form-module");
  const xmlRow = formRows.find(row => row.target === "form");
  await until(async () => (await decoration(codeRow))?.badge === "M", "form code decorated");
  assert.equal(await decoration(xmlRow), undefined, "unchanged form XML stays clean");
  assert.ok(await decoration(form));
  await git("add", ".");
  await git("commit", "-m", "new module and form");
  await repository.status();
  await fs.rm(fixture.module);
  await repository.status();
  await until(async () => !!await decoration(owner), "deleted module marks its owner");
  await vscode.workspace.getConfiguration("git").update("decorations.enabled", false, vscode.ConfigurationTarget.Workspace);
  assert.equal(await decoration(owner), undefined);
  await vscode.workspace.getConfiguration("git").update("decorations.enabled", true, vscode.ConfigurationTarget.Workspace);
  await until(async () => !!await decoration(owner), "decorations reenabled");
  await vscode.commands.executeCommand("eska.explorer.disconnect");
  assert.equal(await decoration(owner), undefined);
  await fs.writeFile(path.join(fixture.root, "host-result.json"), JSON.stringify({ passed: true, vscode: vscode.version, gitDecorations: true }));
};
