import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

/** Parse repository manifests independently from the extension runtime. */
async function json(name) { return JSON.parse(await readFile(new URL(`../${name}`, import.meta.url), "utf8")); }

test("contributions include owned BSL/SDBL syntax without debugger or foreign extension dependencies", async () => {
  const manifest = await json("package.json");
  assert.equal(manifest.name, "eska-explorer");
  assert.equal(manifest.publisher, "1c-tooling");
  assert.deepEqual(manifest.extensionKind, ["workspace"]);
  assert.equal(manifest.capabilities.untrustedWorkspaces.supported, false);
  assert.equal(manifest.capabilities.virtualWorkspaces.supported, false);
  for (const key of ["debuggers", "breakpoints", "configurationDefaults"]) {
    assert.equal(manifest.contributes[key], undefined);
  }
  assert.deepEqual(manifest.contributes.languages.map(language => language.id).sort(), ["bsl", "sdbl"]);
  for (const language of manifest.contributes.languages) {
    assert.deepEqual(language.extensions, [`.${language.id}`]);
    const configuration = await json(language.configuration);
    assert.equal(configuration.comments.lineComment, "//");
    assert.ok(configuration.brackets.length > 0);
    const grammar = manifest.contributes.grammars.filter(value => value.language === language.id);
    assert.equal(grammar.length, 1);
    assert.equal((await json(grammar[0].path)).scopeName, grammar[0].scopeName);
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


test("keyboard overrides are scoped and have native macOS equivalents", async () => {
  const manifest = await json("package.json");
  const bindings = manifest.contributes.keybindings;
  for (const binding of bindings) {
    assert.ok(manifest.contributes.commands.some(command => command.command === binding.command));
    if (binding.key.startsWith("ctrl+k")) {
      assert.equal(binding.mac, binding.key.replace("ctrl", "cmd"));
      assert.ok(binding.when.includes("eska.explorer.activeProject"));
      assert.ok(binding.when.includes("editorTextFocus"));
    } else assert.equal(binding.when, "focusedView == eska.explorer.projects");
  }
});
