import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

const namespace = "http://v8.1c.ru/8.3/MDClasses";
/** Keep UTF-8 BOM, CRLF and a non-BMP character before inline elements to exercise editor offsets. */
export function descriptor(kind, name, children = "", properties = "") {
  return `\ufeff<?xml version="1.0" encoding="UTF-8"?>\r\n<MetaDataObject xmlns="${namespace}" version="2.20">\r\n<${kind} uuid="11111111-1111-1111-1111-111111111111">\r\n<Properties><Name>${name}</Name><Comment>😀 Кириллица</Comment>${properties}</Properties>\r\n<ChildObjects>${children}</ChildObjects>\r\n</${kind}>\r\n</MetaDataObject>`;
}

/** Generate supported inline elements, with two independent branches for selection/invalidation tests. */
export function inline(name = "Артикул") {
  return `<Attribute uuid="22222222-2222-2222-2222-222222222222"><Properties><Name>${name}</Name></Properties></Attribute>\r\n`
    + '<TabularSection uuid="33333333-3333-3333-3333-333333333333"><Properties><Name>Строки</Name></Properties><ChildObjects>'
    + '<Attribute uuid="44444444-4444-4444-4444-444444444444"><Properties><Name>Количество</Name></Properties></Attribute></ChildObjects></TabularSection>';
}

/** Write a complete owned fixture under the caller's playground directory; never run 1C. */
export async function createTreeProject(root, type = "configuration") {
  const source = join(root, "src");
  await mkdir(source, { recursive: true });
  await writeFile(join(root, "eska.toml"), `[project]\nname='tree-test'\ntype='${type}'\n`);
  if (type === "configuration" || type === "extension") {
    await writeFile(join(source, "Configuration.xml"), descriptor("Configuration", "Тест",
      "<Catalog>Товары</Catalog><Catalog>Покупатели</Catalog>", type === "extension" ? "<ConfigurationExtensionPurpose>Patch</ConfigurationExtensionPurpose>" : ""));
    for (const name of ["Товары", "Покупатели"]) {
      await mkdir(join(source, "Catalogs", name, "Ext"), { recursive: true });
      await writeFile(join(source, "Catalogs", `${name}.xml`), descriptor("Catalog", name, inline()));
    }
    await writeFile(join(source, "Catalogs", "Товары", "Ext", "ObjectModule.bsl"), "// Объект\r\n");
    await writeFile(join(source, "Catalogs", "Товары", "Ext", "ManagerModule.bin"), Buffer.from([0, 1, 2, 3]));
    return { root, source, descriptor: join(source, "Catalogs", "Товары.xml"), module: join(source, "Catalogs", "Товары", "Ext", "ObjectModule.bsl") };
  }
  const kind = type === "report" ? "ExternalReport" : "ExternalDataProcessor";
  await writeFile(join(source, "Тест.xml"), descriptor(kind, "Тест", inline()));
  await mkdir(join(source, "Тест", "Ext"), { recursive: true });
  await writeFile(join(source, "Тест", "Ext", "ObjectModule.bsl"), "// Внешний объект\r\n");
  return { root, source, descriptor: join(source, "Тест.xml"), module: join(source, "Тест", "Ext", "ObjectModule.bsl") };
}

/** Add common modules only to tests exercising their direct source navigation. */
export async function addCommonModules(fixture) {
  const { readFile } = await import("node:fs/promises");
  const rootFile = join(fixture.source, "Configuration.xml");
  const names = ["Обмен", "Защищенный"];
  await writeFile(rootFile, (await readFile(rootFile, "utf8")).replace("<ChildObjects>",
    "<ChildObjects>" + names.map(name => `<CommonModule>${name}</CommonModule>`).join("")));
  for (const name of names) {
    await mkdir(join(fixture.source, "CommonModules", name, "Ext"), { recursive: true });
    await writeFile(join(fixture.source, "CommonModules", `${name}.xml`), descriptor("CommonModule", name));
    await writeFile(join(fixture.source, "CommonModules", name, "Ext", name === "Обмен" ? "Module.bsl" : "Module.bin"), "// Common module\r\n");
  }
}
