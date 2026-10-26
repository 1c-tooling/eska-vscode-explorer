import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createQuerySource } from "./query-fixture.mjs";

/** Published analyzer metadata needs real Designer types; generic tree fixtures intentionally omit them. */
export async function createQueryLanguageSource(fixture) {
  fixture.query = await createQuerySource(fixture);
  for (const name of ["Товары", "Покупатели"]) {
    const file = join(fixture.source, "Catalogs", `${name}.xml`);
    let text = await readFile(file, "utf8");
    text = text.replace('version="2.20"', 'xmlns:v8="http://v8.1c.ru/8.1/data/core" xmlns:xs="http://www.w3.org/2001/XMLSchema" version="2.20"')
      .replace(`<Name>${name}</Name>`, `<Name>${name}</Name><CodeLength>9</CodeLength><DescriptionLength>100</DescriptionLength>`)
      .replace('<Name>Артикул</Name>', '<Name>Артикул</Name><Type><v8:Type>xs:string</v8:Type></Type>')
      .replace('<Name>Количество</Name>', '<Name>Количество</Name><Type><v8:Type>xs:decimal</v8:Type></Type>');
    await writeFile(file, text);
  }
  const text = '\ufeff// owner 😀\r\nПроцедура Test()\r\nQ = "SELECT Товар.Ар\r\n|FROM Catalog.Товары AS Товар";\r\nOther = 42;\r\nВспомогательная();\r\nКонецПроцедуры\r\n\r\nФункция Вспомогательная() Экспорт\r\nВозврат 42;\r\nКонецФункции\r\n';
  await writeFile(fixture.module, text);
  const other = join(fixture.source, "Catalogs", "Покупатели", "Ext", "ObjectModule.bsl");
  await writeFile(other, text);
  return { file: fixture.module, text, other };
}

/** Two real applications expose distinct metadata fields while sharing a native workspace and managed config. */
export async function createQueryLanguageContexts(fixture) {
  const { createTreeProject } = await import("./fixture.mjs");
  const members = {};
  for (const name of ["one", "two"]) {
    const member = await createTreeProject(join(fixture.root, name));
    await writeFile(join(member.root, "eska.toml"), `[project]\nname='${name}'\ntype='configuration'\n`);
    const language = await createQueryLanguageSource(member);
    const descriptor = await readFile(member.descriptor, "utf8");
    await writeFile(member.descriptor, descriptor.replace("<Name>Артикул</Name>", `<Name>${name === "one" ? "OnlyFirst" : "OnlySecond"}</Name>`));
    await writeFile(member.module, language.text.replaceAll("Товар.Ар", "Товар.Only"));
    members[name] = member;
  }
  await writeFile(join(fixture.root, "eska.toml"), "[workspace]\n[analysis]\ndefault_application='one'\n[workspace.members.one]\nconfiguration='one'\n[workspace.members.two]\nconfiguration='two'\n");
  return members;
}
