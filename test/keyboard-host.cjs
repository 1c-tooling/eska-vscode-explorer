const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const vscode = require("vscode");

/** Wait for renderer selection events, which arrive after the reveal request completes. */
async function until(predicate, label = "Tree selection was not delivered") {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 30));
  }
  assert.fail(label);
}

/** Exercise the commands on cold trees, preserving unsaved editor contents. */
exports.run = async function () {
  const fixture = JSON.parse(process.env.ESKA_HOST_FIXTURE);
  const { descriptor } = await import("./fixture.mjs");
  await fs.writeFile(path.join(fixture.source, "Configuration.xml"), descriptor("Configuration", "Тест",
    "<Catalog>Товары</Catalog><Catalog>Покупатели</Catalog><CommonModule>CommonDemo</CommonModule><CommonForm>FormDemo</CommonForm>"));
  for (const [folder, kind, name] of [["CommonModules", "CommonModule", "CommonDemo"], ["CommonForms", "CommonForm", "FormDemo"]]) {
    await fs.mkdir(path.join(fixture.source, folder, name, "Ext"), { recursive: true });
    await fs.writeFile(path.join(fixture.source, folder, `${name}.xml`), descriptor(kind, name));
  }
  const common = path.join(fixture.source, "CommonModules/CommonDemo/Ext/Module.bsl");
  const form = path.join(fixture.source, "CommonForms/FormDemo/Ext/Form.xml");
  const formModule = path.join(fixture.source, "CommonForms/FormDemo/Ext/Form/Module.bsl");
  await fs.mkdir(path.dirname(formModule), { recursive: true });
  await fs.writeFile(common, "// common\n");
  await fs.writeFile(form, "<Form/>\n");
  await fs.writeFile(formModule, "// form\n");
  await vscode.workspace.getConfiguration("eska.explorer").update("executable", process.env.ESKA_TEST_BINARY, vscode.ConfigurationTarget.Workspace);
  const explorer = await vscode.extensions.all.find(value => value.packageJSON.name === "eska-explorer").activate();
  await vscode.commands.executeCommand("eska.explorer.connect");
  const errors = [], revealEvents = [];
  const showError = explorer.showError.bind(explorer);
  explorer.showError = error => { errors.push({code:error.code,domain:error.domain,details:error.details}); showError(error); };
  const reveal = explorer.view.reveal.bind(explorer.view);
  explorer.view.reveal = async (entry, options) => {
    try { await reveal(entry, options); revealEvents.push({key:entry.key,options}); }
    catch(error) { revealEvents.push({key:entry.key,error:String(error.stack??error)}); throw error; }
  };
  for (const [file, matches] of [
    [fixture.module, entry => entry?.node?.id.kind === "module" && entry.node.id.role === "object"],
    [fixture.descriptor, entry => entry?.node?.label.text === "Товары"],
    [common, entry => entry?.node?.label.text === "CommonDemo"],
    [form, entry => entry?.owner?.node.label.text === "FormDemo" && entry.target === "form"],
    [formModule, entry => entry?.owner?.node.label.text === "FormDemo" && entry.target === "form-module"],
  ]) {
    const document = await vscode.workspace.openTextDocument(file);
    const editor = await vscode.window.showTextDocument(document);
    if (file === fixture.module) await editor.edit(edit => edit.insert(new vscode.Position(0, 0), "// unsaved\n"));
    await until(() => vscode.window.activeTextEditor === editor, `Active editor was not delivered: ${file}`);
    await vscode.commands.executeCommand("eska.explorer.revealActiveFile");
    try { await until(() => matches(explorer.view.selection[0]), `Tree selection was not delivered: ${file}`); }
    catch(error) {
      await fs.writeFile(path.join(fixture.root,"host-result.json"),JSON.stringify({passed:false,error:String(error.stack??error),
        file,active:vscode.window.activeTextEditor?.document.uri.toString(),errors,revealEvents,
        selection:explorer.view.selection.map(entry=>({key:entry.key,node:entry.node?.id,target:entry.target,owner:entry.owner?.node.id}))}));
      throw error;
    }
    assert.equal(vscode.window.activeTextEditor.document, document);
    if (file === fixture.module) assert.equal(document.isDirty, true);
  }
  await vscode.commands.executeCommand("eska.explorer.search");
  assert.ok(explorer.searchView);
  explorer.searchView.dispose();
  await vscode.commands.executeCommand("eska.explorer.disconnect");
  await fs.writeFile(path.join(fixture.root, "host-result.json"), JSON.stringify({ passed: true, vscode: vscode.version, navigation: 5 }));
};
