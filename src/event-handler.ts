import { ExplorerError, isRecord } from "./protocol.js";
import { type MetadataTree, type TreeEntry } from "./tree.js";

/** Resolve the Designer handler reference through typed nodes in this project only. */
export async function eventHandler(tree: MetadataTree, entry: TreeEntry): Promise<{ module: TreeEntry; name: string }> {
  if (entry.node.id.kind !== "object") throw new ExplorerError("handlerMissing");
  const result = await tree.request(entry.project, "metadata/properties", { objectId: entry.node.id.objectId });
  if (!Array.isArray(result.properties)) throw new ExplorerError("protocolInvalid");
  const handlers = result.properties.filter((property) => isRecord(property) && isRecord(property.key)
    && property.key.namespace === "http://v8.1c.ru/8.3/MDClasses" && property.key.name === "Handler");
  const value = handlers.length === 1 && isRecord(handlers[0].value) ? handlers[0].value : undefined;
  const reference = value?.kind === "text" && typeof value.text === "string"
    ? /^CommonModule\.([\p{L}_][\p{L}\p{N}_]*)\.([\p{L}_][\p{L}\p{N}_]*)$/u.exec(value.text.trim()) : null;
  if (!reference) throw new ExplorerError("handlerMissing");
  const root = await tree.root(entry.project);
  const common = (await tree.children(root)).find((child) => child.node.id.kind === "collection"
    && child.node.id.collection.kind === "common");
  if (!common) throw new ExplorerError("handlerMissing");
  const group = (await tree.children(common)).find((child) => child.node.id.kind === "collection"
    && child.node.id.collection.kind === "metadata" && child.node.id.collection.metadataKind === "common-module");
  if (!group) throw new ExplorerError("handlerMissing");
  const module = (await tree.children(group)).find((child) => child.node.id.kind === "object"
    && child.node.label.kind === "name" && child.node.label.text.toLowerCase() === reference[1]!.toLowerCase());
  if (!module) throw new ExplorerError("handlerMissing");
  return { module, name: reference[2]! };
}

/** Mask strings and comments without changing UTF-16 offsets, including multiline BSL strings. */
export function handlerRange(text: string, name: string): { text: string; start: number; end: number } {
  const code = text.replace(/\/\/[^\r\n]*|"(?:""|[^"])*"/g, (token) => token.replace(/[^\r\n]/g, " "));
  const declarations = /^[\t ]*(?:Процедура|Procedure)[\t ]+([\p{L}_][\p{L}\p{N}_]*)\s*\(/gimu;
  for (const match of code.matchAll(declarations)) {
    if (match[1]!.toLowerCase() !== name.toLowerCase()) continue;
    const start = match.index + match[0].lastIndexOf(match[1]!);
    return { text, start, end: start + match[1]!.length };
  }
  throw new ExplorerError("handlerMissing");
}
