import { readFile, writeFile } from "node:fs/promises";
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
