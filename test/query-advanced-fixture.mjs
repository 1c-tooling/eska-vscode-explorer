import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { descriptor } from "./fixture.mjs";

/** Only advanced-query tests declare this real Designer register; unrelated fixture consumers keep their existing tree. */
export async function addQueryRegister(fixture) {
  const root = join(fixture.source, "Configuration.xml");
  await writeFile(root, (await readFile(root, "utf8")).replace("</ChildObjects>", "<AccumulationRegister>Stock</AccumulationRegister></ChildObjects>"));
  await mkdir(join(fixture.source, "AccumulationRegisters"));
  await writeFile(join(fixture.source, "AccumulationRegisters/Stock.xml"), descriptor("AccumulationRegister", "Stock",
    '<Dimension uuid="55555555-5555-5555-5555-555555555555"><Properties><Name>Item</Name></Properties></Dimension>'
    + '<Resource uuid="66666666-6666-6666-6666-666666666666"><Properties><Name>Quantity</Name></Properties></Resource>', '<RegisterType>Balance</RegisterType>'));
}
