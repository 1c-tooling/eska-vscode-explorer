const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const vscode = require("vscode");

/** Apply real query byte plans through the installed editor model; no query is executed. */
exports.run = async function () {
  const fixture = JSON.parse(process.env.ESKA_HOST_FIXTURE);
  const extension = vscode.extensions.all.find(value => value.packageJSON.name === "eska-explorer");
  const { Connection } = require(path.join(extension.extensionPath, "out/connection.js"));
  const { MetadataTree } = require(path.join(extension.extensionPath, "out/tree.js"));
  const { QueryClient, querySnapshot } = require(path.join(extension.extensionPath, "out/query/client.js"));
  const rootPath = path.join(fixture.source, "Configuration.xml");
  const names = ["EolLF", "EolCRLF", "EolFirstLine"];
  await fs.writeFile(rootPath, (await fs.readFile(rootPath, "utf8")).replace("<ChildObjects>",
    "<ChildObjects>" + names.map(name => "<CommonTemplate>" + name + "</CommonTemplate>").join("")));
  await fs.mkdir(path.join(fixture.source, "Ext"), { recursive: true });
  await fs.writeFile(path.join(fixture.source, "Ext/ParentConfigurations.bin"), "{6,0,0,0,0,0}");
  const cases = [
    { name: names[0], eol: "lf", newline: "\n" },
    { name: names[1], eol: "crlf", newline: "\r\n" },
    { name: names[2], eol: "crlf", newline: "" },
  ];
  for (const scenario of cases) {
    const folder = path.join(fixture.source, "CommonTemplates", scenario.name, "Ext");
    await fs.mkdir(folder, { recursive: true });
    await fs.writeFile(path.join(fixture.source, "CommonTemplates", scenario.name + ".xml"),
      "<MetaDataObject xmlns='http://v8.1c.ru/8.3/MDClasses'><CommonTemplate uuid='22222222-2222-2222-2222-222222222222'><Properties><Name>" + scenario.name + "</Name></Properties></CommonTemplate></MetaDataObject>");
    scenario.relative = "CommonTemplates/" + scenario.name + "/Ext/Template.xml";
    scenario.input = "\ufeff<DataCompositionSchema xmlns='http://v8.1c.ru/8.1/data-composition-system/schema' xmlns:xsi='http://www.w3.org/2001/XMLSchema-instance'>" + scenario.newline
      + "<dataSet xsi:type='DataSetQuery'><name>A</name><query><!--keep--><![CDATA[SELECT 1]]></query></dataSet>" + scenario.newline
      + "</DataCompositionSchema>";
    await fs.writeFile(path.join(fixture.source, scenario.relative), scenario.input);
  }
  const connection = new Connection("eol-native", () => {}, () => {});
  try {
    await connection.connect({ executable: process.env.ESKA_TEST_BINARY, path: fixture.root, name: "eol", locale: "en-US" });
    assert.equal(connection.state.kind, "ready", JSON.stringify(connection.state));
    assert.equal(connection.state.queryEditing.editorLineEndings, true);
    const tree = new MetadataTree(connection, connection.state.session, () => {}, () => {});
    try {
      const project = tree.projects[0];
      const rootRows = await tree.children(await tree.root(project));
      const common = rootRows.find(entry => entry.node.id.collection?.kind === "common");
      const groups = [...rootRows, ...await tree.children(common)];
      const templates = groups.find(entry => entry.node.id.collection?.metadataKind === "common-template");
      const owners = await tree.children(templates);
      const client = new QueryClient(connection, tree.session.sessionId, project, connection.state.queryEditing);
      const results = [];
      for (const scenario of cases) {
        const owner = owners.find(entry => entry.node.label.text === scenario.name);
        assert.ok(owner, scenario.name);
        const native = vscode.Uri.file(path.join(fixture.source, scenario.relative));
        const editorDocument = await vscode.workspace.openTextDocument(native);
        if (!scenario.newline) {
          const editor = await vscode.window.showTextDocument(editorDocument, { preview: false });
          assert.equal(await editor.edit(change => change.setEndOfLine(vscode.EndOfLine.CRLF)), true);
        }
        assert.equal(editorDocument.eol === vscode.EndOfLine.CRLF ? "crlf" : "lf", scenario.eol);
        const exact = editorDocument.getText();
        assert.equal(exact.startsWith("\ufeff"), false);
        const document = await client.open({ node: owner.node.id, source: { value: scenario.relative, encoding: "utf-8" },
          text: exact, version: String(editorDocument.version) });
        let plan;
        try {
          const [header] = await document.list();
          const query = await document.read({ query: header.identity });
          const noOp = await document.plan(query.identity, query.text, [], { lineEnding: scenario.eol });
          assert.equal(noOp.noOp, true); assert.equal(noOp.outputSnapshot, querySnapshot(exact));
          plan = await document.plan(query.identity, "SELECT 2\nFROM T", [], { lineEnding: scenario.eol });
          const edit = new vscode.WorkspaceEdit();
          for (const replacement of plan.replacements) {
            edit.replace(native, new vscode.Range(replacement.rangeUtf16.start.line, replacement.rangeUtf16.start.character,
              replacement.rangeUtf16.end.line, replacement.rangeUtf16.end.character), replacement.text);
          }
          assert.equal(await vscode.workspace.applyEdit(edit), true);
          assert.equal(querySnapshot(editorDocument.getText()), plan.outputSnapshot, scenario.name);
          assert.equal(await fs.readFile(native.fsPath, "utf8"), scenario.input, "planning and applying do not save an owner");
        } finally { await document.close(); }
        const projected = await client.open({ node: owner.node.id, source: { value: scenario.relative, encoding: "utf-8" },
          text: editorDocument.getText(), version: String(editorDocument.version) });
        try {
          const [header] = await projected.list();
          const actual = await projected.read({ query: header.identity });
          assert.deepEqual(actual, plan.projectedQuery, "projected maps must match the actual native text model");
        } finally { await projected.close(); }
        assert.equal(await editorDocument.save(), true);
        assert.equal(await fs.readFile(native.fsPath, "utf8"), "\ufeff" + editorDocument.getText());
        results.push({ name: scenario.name, eol: scenario.eol, snapshotMatched: true, projectedMapMatched: true, bomRetained: true });
      }
      await fs.writeFile(path.join(fixture.root, "host-result.json"), JSON.stringify({ passed: true,
        suite: "T101-real-query-plan-editor-EOL", vscode: vscode.version, node: process.version, results }));
    } finally { tree.dispose(); }
  } finally { await connection.dispose(); }
};
