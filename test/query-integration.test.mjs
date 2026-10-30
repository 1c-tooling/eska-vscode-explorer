import { deferCleanup } from "./cleanup.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { join, resolve, isAbsolute } from "node:path";
import { Connection } from "../out/connection.js";
import { MetadataTree } from "../out/tree.js";
import { QueryClient, querySnapshot } from "../out/query/client.js";
import { createTreeProject, descriptor } from "./fixture.mjs";

const executable = process.env.ESKA_TEST_BINARY;
const namespace = "http://v8.1c.ru/8.1/data-composition-system/schema";

/** Query sources are real declared metadata owned by the test's unique playground directory. */
async function fixture(t) {
  const playground = process.env.ESKA_TEST_ROOT ?? resolve("../eska-playground");
  assert.ok(isAbsolute(playground)); assert.ok(isAbsolute(executable));
  const root = await mkdtemp(join(playground, "explorer-query-"));
  deferCleanup(t, () => rm(root, { recursive: true, force: true }));
  const value = await createTreeProject(root);
  const rootXml = join(value.source, "Configuration.xml");
  await writeFile(rootXml, (await readFile(rootXml, "utf8")).replace("<ChildObjects>",
    "<ChildObjects><CommonTemplate>Схема</CommonTemplate><CommonForm>Списки</CommonForm>"));
  for (const [directory, kind, name] of [["CommonTemplates", "CommonTemplate", "Схема"], ["CommonForms", "CommonForm", "Списки"]]) {
    await mkdir(join(value.source, directory, name, "Ext"), { recursive: true });
    await writeFile(join(value.source, directory, `${name}.xml`), descriptor(kind, name));
  }
  await mkdir(join(value.source, "Ext"), { recursive: true });
  await writeFile(join(value.source, "Ext", "ParentConfigurations.bin"), "{6,0,0,0,0,0}");
  // Oversized inline input, BOM, CRLF, split CDATA/comments and a package remain in the owner only.
  const schema = `\ufeff<DataCompositionSchema xmlns='${namespace}' xmlns:xsi='http://www.w3.org/2001/XMLSchema-instance'>\r\n`
    + `<!--${".".repeat(150000)}-->\r\n<dataSet xsi:type='DataSetQuery'><name>Первый</name><query><!--keep--><![CDATA[ВЫБРАТЬ "😀";\nВЫБРАТЬ 2]]></query></dataSet>\r\n`
    + "<dataSet xsi:type='DataSetUnion'><name>Объединение</name><dataSet xsi:type='DataSetQuery'><name>Второй</name><query>SELECT 2</query></dataSet></dataSet>\r\n"
    + "</DataCompositionSchema>";
  const form = "<Form xmlns='http://v8.1c.ru/8.3/xcf/logform' xmlns:xsi='http://www.w3.org/2001/XMLSchema-instance'><Attributes>"
    + "<Attribute name='Список' id='1'><Settings xsi:type='DynamicList'><ManualQuery>true</ManualQuery><QueryText>ВЫБРАТЬ &quot;😀&quot;</QueryText></Settings></Attribute>"
    + "<Attribute name='Второй' id='2'><Settings xsi:type='DynamicList'><ManualQuery>1</ManualQuery><QueryText>SELECT 2</QueryText></Settings></Attribute>"
    + "<Attribute name='Автоматический' id='3'><Settings xsi:type='DynamicList'><ManualQuery>false</ManualQuery><MainTable>Catalog.Товары</MainTable></Settings></Attribute>"
    + "</Attributes></Form>";
  const schemaPath = "CommonTemplates/Схема/Ext/Template.xml", formPath = "CommonForms/Списки/Ext/Form.xml";
  await writeFile(join(value.source, schemaPath), schema);
  await writeFile(join(value.source, formPath), form);
  await mkdir(join(root, "bsl-analyzer.toml"));
  return { ...value, schema, form, schemaPath, formPath };
}

/** Resolve opaque owner IDs from the actual backend tree rather than guessing their representation. */
async function owner(tree, project, kind) {
  const groups = [...await tree.children(await tree.root(project))];
  const common = groups.find(entry => entry.node.id.collection?.kind === "common");
  if (common) groups.push(...await tree.children(common));
  const group = groups.find(entry => entry.node.id.collection?.metadataKind === kind);
  assert.ok(group, kind);
  const entries = await tree.children(group);
  assert.equal(entries.length, 1); return entries[0];
}

for (const locale of ["ru-RU", "en-US"]) test(`query client with real API 1.13: dirty XML, map, plan and conflicts (${locale})`, { skip: !executable }, async t => {
  const files = await fixture(t);
  const connection = new Connection("query-test", () => {}, () => {});
  deferCleanup(t, () => connection.dispose());
  await connection.connect({ executable, path: files.root, name: "queries", locale });
  const state = connection.state;
  assert.equal(state.kind, "ready", JSON.stringify(state)); assert.ok(state.queryEditing);
  const tree = new MetadataTree(connection, state.session, () => {}, () => {});
  deferCleanup(t, () => tree.dispose());
  const project = tree.projects[0];
  const client = new QueryClient(connection, state.session.sessionId, project, { ...state.queryEditing, maxListItems: 1 });
  const schemaOwner = await owner(tree, project, "common-template");
  const dirty = files.schema.replace("<!--keep-->", "<!--unsaved-->");
  const document = await client.open({ node: schemaOwner.node.id,
    source: { value: files.schemaPath, encoding: "utf-8" }, version: "7", text: dirty });
  deferCleanup(t, () => document.close());
  assert.equal(document.binding.snapshot, querySnapshot(dirty));
  assert.equal(document.diskSnapshot, querySnapshot(files.schema)); assert.equal(document.writable, true);
  const headers = await document.list();
  assert.deepEqual(headers.map(row => row.identity), [{ kind: "dataSet", path: ["Первый"] }, { kind: "dataSet", path: ["Объединение", "Второй"] }]);
  const query = await document.read({ query: headers[0].identity });
  assert.equal(query.text, 'ВЫБРАТЬ "😀";\nВЫБРАТЬ 2');
  assert.equal(query.comments.length, 1);
  const noOp = await document.plan(query.identity, query.text);
  assert.equal(noOp.noOp, true); assert.equal(noOp.outputSnapshot, querySnapshot(dirty));
  const draft = 'ВЫБРАТЬ "😀";\nВЫБРАТЬ 3';
  const plan = await document.plan(query.identity, draft);
  assert.equal(plan.noOp, false); assert.equal(plan.projectedQuery.text, draft);
  const expected = dirty.replace('<![CDATA[ВЫБРАТЬ "😀";\nВЫБРАТЬ 2]]>', 'ВЫБРАТЬ "😀";\nВЫБРАТЬ 3');
  assert.equal(plan.outputSnapshot, querySnapshot(expected));
  assert.equal(await readFile(join(files.source, files.schemaPath), "utf8"), files.schema);
  const mapped = await document.map(query.identity, "queryToSource", [{ line: 0, character: 9 }]);
  assert.equal(mapped[0].character > 0, true);
  await assert.rejects(document.map(query.identity, "queryToSource", [{ line: 0, character: 10 }]),
    error => error.domain === "query_failed" && error.details.reason === "invalid_position");
  await document.close(); await document.close();
  await assert.rejects(document.read({ query: query.identity }), { code: "obsolete" });
  const formOwner = await owner(tree, project, "common-form");
  const lists = await client.open({ node: formOwner.node.id, source: { value: files.formPath, encoding: "utf-8" }, version: "2", text: files.form });
  deferCleanup(t, () => lists.close());
  const listHeaders = await lists.list();
  assert.deepEqual(listHeaders.map(row => row.identity.name), ["Список", "Второй"]);
  const list = await lists.read({ query: listHeaders[0].identity });
  const listPlan = await lists.plan(list.identity, "ВЫБРАТЬ A < 2 & B");
  assert.equal(listPlan.outputSnapshot, querySnapshot(files.form.replace("ВЫБРАТЬ &quot;😀&quot;", "ВЫБРАТЬ A &lt; 2 &amp; B")));
  await writeFile(join(files.source, files.formPath), files.form.replace("SELECT 2", "SELECT 99"));
  await assert.rejects(lists.plan(list.identity, "SELECT 3"), error => {
    assert.equal(error.domain, "query_failed", JSON.stringify(error));
    assert.equal(error.details.reason, "conflict", JSON.stringify(error)); return true;
  });
  await lists.close();
});
