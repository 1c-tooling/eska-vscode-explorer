import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { metadataIcons, collectionIcons, projectIcons, moduleIcons, iconName } from "../out/icons.js";
import { parseNode } from "../out/tree.js";

/** A fixture identity deliberately gives no usable hint of the object's actual kind. */
function node(kind) {
  return { id: { kind: "object", objectId: "opaque" }, metadataKind: kind, parent: null,
    label: { kind: "name", text: "Unrelated" }, state: "empty", expandedByDefault: false, rootSection: false };
}

test("all backend metadata kinds have local artwork in every supported theme", async () => {
  const vocabulary = await readFile(new URL("../src/kind-labels.ts", import.meta.url), "utf8");
  const kinds = [...vocabulary.matchAll(/^  "([a-z-]+)":/gm)].map(match => match[1]);
  assert.equal(kinds.length, 68);
  assert.deepEqual(Object.keys(metadataIcons).sort(), kinds.sort());
  const names = new Set([...Object.values(metadataIcons), ...Object.values(moduleIcons), ...Object.values(collectionIcons), ...Object.values(projectIcons), "unknown", "common", "modules"]);
  for (const theme of ["light", "dark", "contrast", "contrast-light"]) {
    const folder = new URL(`../resources/icons/${theme}/`, import.meta.url);
    for (const name of names) {
      const svg = await readFile(new URL(`${name}.svg`, folder), "utf8");
      assert.match(svg, /viewBox="0 0 24 24"/);
      assert.match(svg, /mask="url\(#cut\)"/);
      assert.doesNotMatch(svg, /<script|<image|<foreignObject|(?:href|xlink:href)=|CUT/);
    }
    assert.deepEqual((await readdir(folder)).sort(), [...names].map(name => `${name}.svg`).sort());
  }
});

test("icon selection uses explicit kinds/roles and safely handles old or future backends", () => {
  for (const [kind, name] of Object.entries(metadataIcons)) {
    assert.equal(iconName(node(kind)), name);
    assert.equal(iconName({ ...node(), id: { kind: "collection", owner: "opaque", collection: { kind: "metadata", metadataKind: kind } } }), collectionIcons[kind] ?? name);
  }
  for (const [role, name] of Object.entries(moduleIcons)) {
    assert.equal(iconName({ ...node(), id: { kind: "module", owner: "opaque", role } }), name);
  }
  for (const kind of [undefined, null, "../../other", "__proto__", "future-kind"]) assert.equal(iconName(parseNode(node(kind))), "unknown");
  assert.throws(() => parseNode(node({ kind: "catalog" })), { code: "protocolInvalid" });
  assert.equal(iconName({ ...node(), id: { kind: "module", owner: "opaque", role: "future" } }), "unknown");
  for (const [kind, expected] of [["common", "common"], ["modules", "modules"], ["unsupported", "unknown"]]) {
    assert.equal(iconName({ ...node(), id: { kind: "collection", owner: "opaque", collection: { kind } } }), expected);
  }
});

test("project roots use the declared project type without changing nested objects", () => {
  for (const [type, expected] of Object.entries(projectIcons)) {
    assert.equal(iconName(node("configuration"), type), expected);
    assert.equal(iconName({ ...node("configuration"), parent: { kind: "object", objectId: "parent" } }, type), "configuration");
  }
  assert.equal(new Set(Object.values(projectIcons)).size, 4);
});

test("collections have distinct artwork and predefined items retain the field silhouette", async () => {
  const names = Object.keys(metadataIcons).map(kind => collectionIcons[kind] ?? metadataIcons[kind]);
  assert.equal(new Set(names).size, names.length);
  for (const theme of ["light", "dark", "contrast", "contrast-light"]) {
    const folder = new URL(`../resources/icons/${theme}/`, import.meta.url);
    const artwork = await Promise.all(names.map(name => readFile(new URL(`${name}.svg`, folder), "utf8")));
    assert.equal(new Set(artwork).size, artwork.length);
    const attribute = await readFile(new URL("attribute.svg", folder), "utf8");
    const predefined = await readFile(new URL("predefined-item.svg", folder), "utf8");
    assert.equal(predefined, attribute.replaceAll("#6c9fc3", "#8b80bb"));
  }
});
