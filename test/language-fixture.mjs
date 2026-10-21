import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { addCommonModules } from "./fixture.mjs";

export const LANGUAGE_TEXT = "// Возвращает переданное значение.\nФункция Проверка(Значение) Экспорт\n    Возврат Значение;\nКонецФункции\n\nРезультат = Проверка(\"текст\");\n";

/** Keep protocol fixtures independent of a platform installation while retaining ordinary Designer XML properties. */
export async function createLanguageSource(fixture) {
  await addCommonModules(fixture);
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
