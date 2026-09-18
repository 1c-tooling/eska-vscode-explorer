import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

/** Parse repository manifests independently from the extension runtime. */
async function json(name) { return JSON.parse(await readFile(new URL(`../${name}`, import.meta.url), "utf8")); }

test("contributions stay within Explorer and preserve independent BSL providers", async () => {
  const manifest = await json("package.json");
  assert.equal(manifest.name, "eska-explorer");
  assert.equal(manifest.publisher, "1c-tooling");
  assert.deepEqual(manifest.extensionKind, ["workspace"]);
  assert.equal(manifest.capabilities.untrustedWorkspaces.supported, false);
  assert.equal(manifest.capabilities.virtualWorkspaces.supported, false);
  for (const key of ["languages", "grammars", "debuggers", "breakpoints", "configurationDefaults"]) {
    assert.equal(manifest.contributes[key], undefined);
  }
  assert.equal(manifest.extensionDependencies, undefined);
  assert.equal(manifest.browser, undefined);
  for (const command of manifest.contributes.commands) assert.ok(command.command.startsWith("eska.explorer."));
  for (const key of Object.keys(manifest.contributes.configuration.properties)) assert.ok(key.startsWith("eska.explorer."));
});

test("all manifest localization references resolve in both languages", async () => {
  const manifest = await json("package.json");
  const en = await json("package.nls.json");
  const ru = await json("package.nls.ru.json");
  assert.deepEqual(Object.keys(en).sort(), Object.keys(ru).sort());
  for (const [, key] of JSON.stringify(manifest).matchAll(/%([a-zA-Z]+)%/g)) {
    assert.ok(en[key]);
    assert.ok(ru[key]);
  }
});
