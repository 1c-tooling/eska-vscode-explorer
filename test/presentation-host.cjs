const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const vscode = require("vscode");

/** Exercise source presentation in the real native provider and editor. */
exports.run = async function () {
  const fixture = JSON.parse(process.env.ESKA_HOST_FIXTURE);
  const { descriptor } = await import("./fixture.mjs");
  /** Write only this host test's own source files. */
  async function put(name, contents) {
    const file = path.join(fixture.source, name);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, contents);
    return file;
  }
  const cases = [
    ["Bot", "Bots", "BotDemo", "Module.bsl", ""],
    ["WebSocketClient", "WebSocketClients", "SocketDemo", "Module.bsl", ""],
    ["CommonCommand", "CommonCommands", "CommandDemo", "CommandModule.bsl", ""],
    ["HTTPService", "HTTPServices", "HttpDemo", "Module.bsl", '<URLTemplate uuid="url"><Properties><Name>UrlDemo</Name></Properties><ChildObjects><Method uuid="method"><Properties><Name>GetDemo</Name></Properties></Method></ChildObjects></URLTemplate>'],
    ["WebService", "WebServices", "WebDemo", "Module.bsl", '<Operation uuid="op"><Properties><Name>OperationDemo</Name></Properties><ChildObjects><Parameter uuid="param"><Properties><Name>ParameterDemo</Name></Properties></Parameter></ChildObjects></Operation>'],
    ["IntegrationService", "IntegrationServices", "IntegrationDemo", "Module.bsl", '<IntegrationServiceChannel uuid="channel"><Properties><Name>ChannelDemo</Name></Properties></IntegrationServiceChannel>'],
    ["CommonForm", "CommonForms", "FormDemo", undefined, ""],
    ["CalculationRegister", "CalculationRegisters", "RegisterDemo", undefined, '<Recalculation>RecalcDemo</Recalculation>'],
  ];
  const rootFile = path.join(fixture.source, "Configuration.xml");
  await fs.writeFile(rootFile, (await fs.readFile(rootFile, "utf8")).replace("<ChildObjects>",
    "<ChildObjects>" + cases.map(([tag, , name]) => `<${tag}>${name}</${tag}>`).join("")));
  const modules = new Map();
  for (const [tag, folder, name, file, children] of cases) {
    await put(`${folder}/${name}.xml`, descriptor(tag, name, children));
    if (file) modules.set(name, await put(`${folder}/${name}/Ext/${file}`, "// demo\r\n"));
  }
  const recalc = "CalculationRegisters/RegisterDemo/Recalculations/RecalcDemo";
  await put(`${recalc}.xml`, descriptor("Recalculation", "RecalcDemo", '<Dimension uuid="key"><Properties><Name>DimensionDemo</Name></Properties></Dimension>'));
  modules.set("RecalcDemo", await put(`${recalc}/Ext/RecordSetModule.bsl`, "// recalc\r\n"));
  const formPath = await put("CommonForms/FormDemo/Ext/Form.xml", "<Form/>\r\n");
  const formModule = await put("CommonForms/FormDemo/Ext/Form/Module.bsl", "// form\r\n");
  const config = vscode.workspace.getConfiguration("eska.explorer");
  await config.update("executable", process.env.ESKA_TEST_BINARY, vscode.ConfigurationTarget.Workspace);
  await config.update("treeLanguage", "ru-RU", vscode.ConfigurationTarget.Workspace);
  const extension = vscode.extensions.all.find(value => value.packageJSON.name === "eska-explorer");
  const explorer = await extension.activate();
  await vscode.commands.executeCommand("eska.explorer.connect");
  const entries = new Map();
  /** Collect the tiny fixture through the public native provider. */
  async function walk(owner) {
    for (const entry of await explorer.getChildren(owner)) {
      assert.ok(entry.node || entry.owner, `Unexpected notice: ${entry.label}`);
      if (!entry.node) continue;
      if (entry.node.label.kind === "name") entries.set(entry.node.label.text, entry);
      await walk(entry);
    }
  }
  await walk();
  for (const name of ["UrlDemo", "GetDemo", "OperationDemo", "ParameterDemo", "ChannelDemo", "DimensionDemo"]) {
    assert.ok(entries.has(name), `Preserved nested object ${name}`);
  }
  for (const [name, file] of modules) {
    const entry = entries.get(name);
    assert.ok(entry, name);
    const children = await explorer.getChildren(entry);
    assert.ok(!children.some(child => child.node?.id.collection?.kind === "modules"), `Hidden module group: ${name}`);
    const item = explorer.getTreeItem(entry);
    await vscode.commands.executeCommand(item.command.command, ...item.command.arguments);
    assert.equal(vscode.window.activeTextEditor.document.uri.fsPath, file);
    await vscode.commands.executeCommand("eska.explorer.openXml", entry);
    assert.match(vscode.window.activeTextEditor.document.uri.fsPath, /\.xml$/);
  }
  const form = entries.get("FormDemo");
  const rows = await explorer.getChildren(form);
  assert.deepEqual(rows.map(row => explorer.getTreeItem(row).label), ["Форма", "Модуль"]);
  assert.equal(await explorer.getChildren(form), rows, "source rows reuse the loaded branch");
  for (let index = 0; index < rows.length; index++) {
    assert.equal(explorer.getParent(rows[index]), form);
    const item = explorer.getTreeItem(rows[index]);
    await vscode.commands.executeCommand(item.command.command, ...item.command.arguments);
    assert.equal(vscode.window.activeTextEditor.document.uri.fsPath, [formPath, formModule][index]);
  }
  await config.update("treeLanguage", "en-US", vscode.ConfigurationTarget.Workspace);
  assert.deepEqual(rows.map(row => explorer.getTreeItem(row).label), ["Form", "Module"]);
  await fs.rename(formModule, formModule.replace(/\.bsl$/, ".bin"));
  const deadline = Date.now() + 15000;
  let current = rows;
  while (Date.now() < deadline) {
    current = await explorer.getChildren(form);
    if (current.length === 1 && current[0].target === "form") break;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  assert.deepEqual(current.map(row => row.target), ["form"], "watch invalidates cached form sources; bin-only module stays hidden");
  await fs.writeFile(path.join(fixture.root, "host-result.json"), JSON.stringify({ passed: true, directModules: modules.size, nestedChildren: 6, formSources: 2 }));
};
