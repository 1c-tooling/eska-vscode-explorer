import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { handlerRange } from "../out/event-handler.js";
import { resolveSource } from "../out/source.js";
import { Connection } from "../out/connection.js";
import { MetadataTree } from "../out/tree.js";
import { createTreeProject, addCommonModules, descriptor } from "./fixture.mjs";

/** Exercise lexical false positives, case folding and editor offsets independently of the backend. */
test("handler navigation selects declarations, ignoring comments and multiline strings", () => {
  const text = '// 😀 Процедура ПриЗаписи()\r\nСтрока = "Текст\r\n|Procedure ПриЗаписи()\r\n|""цитата""";\r\n'
    + 'Процедура ПриЗаписиДругого()\r\nКонецПроцедуры\r\n\tпРоЦеДуРа ПриЗаписи(Источник) Экспорт\r\nКонецПроцедуры';
  const range = handlerRange(text, "призаписи");
  assert.equal(range.start, text.lastIndexOf("ПриЗаписи("));
  assert.equal(text.slice(range.start, range.end), "ПриЗаписи");
  assert.equal(handlerRange("Процедура Проц()", "Проц").start, 10);
  assert.equal(handlerRange('Procedure OnWrite(\nSource) Export\nEndProcedure', 'onwrite').start, 10);
  assert.throws(() => handlerRange('// Procedure Missing()\nFunction Missing()\nEndFunction', 'Missing'), { code: "handlerMissing" });
});

/** Real protocol properties and source mappings must work with unopened common-module branches. */
test("event subscriptions navigate within each project and retain explicit XML navigation", {
  skip: !process.env.ESKA_TEST_BINARY,
}, async t => {
  const root = await mkdtemp(join(process.env.ESKA_TEST_ROOT ?? resolve("../eska-playground"), "explorer-handler-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const connection = new Connection("test", () => {}, () => {});
  t.after(() => connection.dispose());
  for (const type of ["configuration", "extension"]) {
    const fixture = await createTreeProject(join(root, type), type);
    await addCommonModules(fixture);
    const rootFile = join(fixture.source, "Configuration.xml");
    await writeFile(rootFile, (await readFile(rootFile, "utf8")).replace("<ChildObjects>", '<ChildObjects><EventSubscription>ПриЗаписи</EventSubscription>'));
    await mkdir(join(fixture.source, "EventSubscriptions"));
    const xml = join(fixture.source, "EventSubscriptions", "ПриЗаписи.xml");
    const module = join(fixture.source, "CommonModules", "Обмен", "Ext", "Module.bsl");
    const code = `\ufeff// 😀 ${type}\r\nПроцедура ПриЗаписи(Источник) Экспорт\r\nКонецПроцедуры\r\n`;
    await writeFile(module, code);
    await writeFile(xml, descriptor("EventSubscription", "ПриЗаписи", "", '<Handler>CommonModule.Обмен.ПриЗаписи</Handler>'));
    await connection.connect({ executable: process.env.ESKA_TEST_BINARY, path: fixture.root, name: "test", locale: "ru-RU" });
    assert.equal(connection.state.kind, "ready");
    const tree = new MetadataTree(connection, connection.state.session, () => {}, () => {});
    const [top] = await tree.roots();
    const common = (await tree.children(top)).find(e => e.node.id.collection?.kind === "common");
    const groups = await tree.children(common);
    const modules = groups.find(e => e.node.id.collection?.metadataKind === "common-module");
    assert.equal(modules.children, undefined);
    const subscriptions = groups.find(e => e.node.id.collection?.metadataKind === "event-subscription");
    const [entry] = await tree.children(subscriptions);
    const source = await resolveSource(tree, entry);
    assert.equal(source.path, module);
    assert.equal(source.position.text, code.slice(1));
    assert.equal(source.position.text.slice(source.position.start, source.position.end), "ПриЗаписи");
    assert.equal((await resolveSource(tree, entry, "xml")).path, xml);
    for (const handler of ["", "CommonModule.НетМодуля.ПриЗаписи", "CommonModule.Обмен.НетПроцедуры", "CommonModule.../Обмен.ПриЗаписи"]) {
      await writeFile(xml, descriptor("EventSubscription", "ПриЗаписи", "", `<Handler>${handler}</Handler>`));
      await tree.refresh(entry.project, entry);
      await assert.rejects(resolveSource(tree, entry), { code: "handlerMissing" });
      assert.equal((await resolveSource(tree, entry, "xml")).path, xml);
    }
    tree.dispose();
  }
});
