import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { addCommonModules, createTreeProject } from "./fixture.mjs";

export const LANGUAGE_TEXT = "// Возвращает переданное значение.\nФункция Проверка(Значение) Экспорт\n    Возврат Значение;\nКонецФункции\n\nРезультат = Проверка(\"текст\");\n";

/** A raw reference dump outside the EPF has no ESKA manifest and must never become a writable workspace member. */
export async function createReferenceSource(fixture, owner) {
  const base = await createTreeProject(join(owner, "База с БСП"));
  const language = await createLanguageSource(base);
  await rm(join(base.root, "eska.toml"));
  await writeFile(join(fixture.root, "eska.toml"), `[project]\ntype='processing'\n[analysis.configuration]\nsource=${JSON.stringify(base.source)}\n[tools.bsl-analyzer.diagnostics.parameters]\nLineLength=false\n`);
  await writeFile(fixture.module, "Процедура Использовать()\n    Значение = Обмен.Проверка(1);\nКонецПроцедуры\n");
  return { ...base, definition: language.file };
}

/** Keep protocol fixtures independent of a platform installation while retaining ordinary Designer XML properties. */
export async function createLanguageSource(fixture) {
  await addCommonModules(fixture);
  // Unknown support data is read-only; this editable fixture explicitly has no parent configuration.
  await mkdir(join(fixture.source, "Ext"), { recursive: true });
  await writeFile(join(fixture.source, "Ext", "ParentConfigurations.bin"), "{6,0,0,0,0,0}");
  const descriptor = join(fixture.source, "CommonModules", "Обмен.xml");
  await writeFile(descriptor, (await readFile(descriptor, "utf8")).replace("</Properties>",
    "<Global>false</Global><ClientManagedApplication>false</ClientManagedApplication><Server>true</Server><ExternalConnection>true</ExternalConnection><ClientOrdinaryApplication>false</ClientOrdinaryApplication><ServerCall>false</ServerCall><Privileged>false</Privileged><ReturnValuesReuse>DontUse</ReturnValuesReuse></Properties>"));
  const file = join(fixture.source, "CommonModules", "Обмен", "Ext", "Module.bsl");
  await writeFile(file, LANGUAGE_TEXT);
  return { file, text: LANGUAGE_TEXT };
}

/** Reuse the established support fixture: owner modules are editable, shared XML includes a locked attribute. */
export async function createLanguageSupportSource(fixture) {
  const source = await createLanguageSource(fixture), owner = "11111111-1111-1111-1111-111111111111", attribute = "22222222-2222-2222-2222-222222222222";
  await mkdir(join(fixture.source, "Ext"), { recursive: true });
  await writeFile(join(fixture.source, "Ext", "ParentConfigurations.bin"),
    `{6,0,1,${owner},0,${owner},"1","Vendor","Fixture",2,1,0,${owner},${owner},0,0,${attribute},${attribute},0,0,0,1,0,0,0,1,0,1,0,1,1,1,1}`);
  return source;
}

/** Prepare both editable common modules before workspaceContains can activate policy and language observers. */
export async function createLanguageMutationSource(fixture) {
  const source = await createLanguageSupportSource(fixture);
  const original = await readFile(join(fixture.source, "CommonModules", "Обмен.xml"), "utf8");
  await writeFile(join(fixture.source, "CommonModules", "Защищенный.xml"), original.replace("<Name>Обмен</Name>", "<Name>Защищенный</Name>"));
  const caller = join(fixture.source, "CommonModules", "Защищенный", "Ext", "Module.bsl");
  await rm(join(fixture.source, "CommonModules", "Защищенный", "Ext", "Module.bin"));
  await writeFile(caller, "Процедура Использовать()\n    Значение = Обмен.Проверка(1);\nКонецПроцедуры\n");
  return { ...source, caller };
}

/** Give every owned BSL file a unique diagnostic so a cleared editor collection cannot impersonate a completed analysis. */
export async function createLanguageParitySource(fixture) {
  const source = await createLanguageSupportSource(fixture);
  for (const [index, file] of [source.file, fixture.module].entries()) {
    const text = await readFile(file, "utf8");
    await writeFile(file, text + `\nПроцедура ESKAParity${index}() Экспорт\n    ESKAParitySentinel${index} = 1;\nКонецПроцедуры\n`);
  }
  return source;
}


/** Named-library acceptance owns both XML dumps and a private machine catalog outside the consumer. */
export async function createLibrarySource(fixture, owner) {
  const first = await createReferenceSource(fixture, owner);
  const second = await createTreeProject(join(owner, "Другая БСП"));
  const language = await createLanguageSource(second);
  await rm(join(second.root, "eska.toml"));
  await writeFile(join(fixture.root, "eska.toml"), "[project]\ntype='processing'\n[analysis.configuration]\nlibrary='ssl_3_1'\n[tools.bsl-analyzer.diagnostics.parameters]\nLineLength=false\n");
  const configDir = join(owner, "Настройки с пробелами"), config = join(configDir, "config.toml");
  await mkdir(configDir);
  await writeFile(config, "[build]\nrunner='host'\n[libraries.ssl_3_1]\nsource=" + JSON.stringify(relative(configDir, first.source)) + "\n");
  return { first, second: { ...second, definition: language.file }, configDir, config };
}

/** Real semantic hints cover the requested builtin, a local function and a nested call. */
export async function createInlaySource(fixture) {
  const source = await createLanguageSource(fixture);
  const text = '\ufeffФункция Собрать(Шаблон, Дополнение)\n    Возврат Шаблон + Дополнение;\nКонецФункции\n\nПроцедура Test()\n    А = СтрШаблон("Найдено кандидатов: %1\n        |Время выполнения: %2\n        |""Кириллица"" 😀", 1, 2);\n    Б = Собрать("Своя строка\n\t|Её продолжение", "два");\n    В = Собрать(СтрШаблон("Вложенный текст\n        |Его продолжение", 1), "два");\n    Г = Собрать("Одиночный текст", "два");\n    Д = Собрать("Первая цепочка\n        |Конец первой", "Начало второй\n        |Конец второй");\nКонецПроцедуры\n'.replaceAll('\n', '\r\n');
  await writeFile(source.file, text);
  return { file: source.file, text };
}
