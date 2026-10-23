import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

/** Prepare every query source before workspace activation can observe metadata or settings changes. */
export async function createQuerySource(fixture) {
  const rootPath = join(fixture.source, "Configuration.xml");
  await writeFile(rootPath, (await readFile(rootPath, "utf8")).replace("<ChildObjects>",
    "<ChildObjects><CommonTemplate>Queries</CommonTemplate><CommonForm>Lists</CommonForm>"));
  await mkdir(join(fixture.source, "Ext"), { recursive: true });
  await writeFile(join(fixture.source, "Ext/ParentConfigurations.bin"), "{6,0,0,0,0,0}");
  for (const [directory, kind, name] of [["CommonTemplates", "CommonTemplate", "Queries"], ["CommonForms", "CommonForm", "Lists"]]) {
    await mkdir(join(fixture.source, directory, name, "Ext"), { recursive: true });
    await writeFile(join(fixture.source, directory, name + ".xml"),
      `<MetaDataObject xmlns='http://v8.1c.ru/8.3/MDClasses'><${kind} uuid='22222222-2222-2222-2222-222222222222'><Properties><Name>${name}</Name></Properties></${kind}></MetaDataObject>`);
  }
  const schemaPath = join(fixture.source, "CommonTemplates/Queries/Ext/Template.xml");
  const schema = "\ufeff<DataCompositionSchema xmlns='http://v8.1c.ru/8.1/data-composition-system/schema' xmlns:xsi='http://www.w3.org/2001/XMLSchema-instance'>\r\n"
    + "<dataSet xsi:type='DataSetQuery'><name>A</name><query><!--keep--><![CDATA[SELECT 1;\r\n// пакет 😀\r\nSELECT 77]]></query></dataSet>\r\n"
    + "<dataSet xsi:type='DataSetQuery'><name>B</name><query>SELECT 2</query></dataSet>\r\n<other>before</other>\r\n</DataCompositionSchema>\r\n";
  await writeFile(schemaPath, schema);
  const formPath = join(fixture.source, "CommonForms/Lists/Ext/Form.xml");
  const form = "<Form xmlns='http://v8.1c.ru/8.3/xcf/logform' xmlns:xsi='http://www.w3.org/2001/XMLSchema-instance'><Attributes>"
    + "<Attribute name='List' id='1'><Settings xsi:type='DynamicList'><ManualQuery>true</ManualQuery><QueryText>SELECT 1</QueryText></Settings></Attribute>"
    + "<Attribute name='Second' id='2'><Settings xsi:type='DynamicList'><ManualQuery>1</ManualQuery><QueryText>SELECT 2</QueryText></Settings></Attribute>"
    + "<Attribute name='Auto' id='3'><Settings xsi:type='DynamicList'><ManualQuery>false</ManualQuery><MainTable>Catalog.Товары</MainTable></Settings></Attribute>"
    + "</Attributes></Form>";
  await writeFile(formPath, form);
  return { schemaPath, formPath };
}
