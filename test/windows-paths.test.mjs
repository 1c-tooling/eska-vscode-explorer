import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { win32 } from "node:path";
import { pathToFileURL } from "node:url";
import { runInNewContext } from "node:vm";

/** Exercise the Windows decoder and context parser without changing the test runner's host platform. */
function windowsModules(platform = "win32") {
  const load = (name, overrides = {}) => {
    const url = new URL(`../out/${name}.js`, import.meta.url), require = createRequire(url), module = { exports: {} };
    runInNewContext(`(function(require,module,exports){${readFileSync(url, "utf8")}\n})`, {
      process: { platform }, Buffer, TextDecoder,
    })(name => overrides[name] ?? require(name), module, module.exports);
    return module.exports;
  };
  const source = load("source");
  return { ...source, ...load("language/context", { "node:path": win32, "../source.js": source }) };
}

/** Canonical local and UNC roots must address the same files as editor-native file URIs. */
test("verbatim Windows roots, descriptors and analyzer configs become ordinary file paths", () => {
  const { nativePath, analysisContext, analyzerConfiguration } = windowsModules();
  const wire = value => ({ value, encoding: "utf-8" });
  // Bun rewrites non-ASCII raw template chunks; cooked literals retain actual Cyrillic path names.
  for (const [raw, plain] of [
    ["\\\\?\\C:\\Работа #1\\100%", "C:\\Работа #1\\100%"],
    ["\\\\?\\UNC\\server\\share\\Проект", "\\\\server\\share\\Проект"],
    ["\\\\?\\unc\\server\\share", "\\\\server\\share"],
  ]) {
    if (plain.startsWith("C:")) assert.ok(raw.includes("Работа"), "the fixture contains actual Cyrillic characters");
    assert.equal(nativePath(wire(raw)), plain);
    const context = analysisContext({ schema_version: 1, kind: "project-context", status: "ready", context: {
      root: wire(raw), name: null, limited_context: false, sources: [{ root: wire(raw), source: wire(`${raw}\\src`),
        descriptor: wire("Configuration.xml"), member: null, role: "configuration", project_type: "configuration", library: { name: "ssl_3_1", configuration: wire(win32.join(raw, "config.toml")) } }],
    } });
    assert.equal(context.root, plain);
    assert.equal(context.sources[0].library.configuration, win32.join(plain, "config.toml"));
    assert.equal(context.sources[0].descriptor, win32.join(plain, "src", "Configuration.xml"));
    const uri = pathToFileURL(context.root, { windows: true });
    assert.notEqual(uri.hostname, "?");
    assert.equal(uri.href, pathToFileURL(plain, { windows: true }).href);
    const config = analyzerConfiguration({ schema_version: 1, kind: "analyzer-configuration", status: "current",
      path: wire(`${raw}\\bsl-analyzer.toml`), preview_token: "a".repeat(64), ownership: {
        schema_version: 1, generator_version: 1, analyzer_version: "0.4.0", context: null,
        input_fingerprint: "b".repeat(64), body_sha256: "c".repeat(64),
      } });
    assert.equal(config.path, win32.join(context.root, "bsl-analyzer.toml"));
  }
});

/** URI normalization must neither corrupt Unix names nor accept a Win32 device namespace as a file. */
test("ordinary paths retain their bytes and unsupported Windows namespaces are rejected", () => {
  const wire = value => ({ value, encoding: "utf-8" });
  const windows = windowsModules(), unix = windowsModules("linux");
  for (const plain of ["C:\\Проект\\file #1.bsl", "\\\\server\\share\\file.bsl", "src/Module.bsl"])
    assert.equal(windows.nativePath(wire(plain)), plain);
  const verbatim = "\\\\?\\C:\\literal-unix-name";
  assert.equal(unix.nativePath(wire(verbatim)), verbatim);
  assert.throws(() => windows.nativePath(wire("\\\\?\\GLOBALROOT\\Device\\Harddisk0")), { code: "unsupportedPath" });
  assert.throws(() => windows.nativePath(wire("\\\\?\\UNC\\server")), { code: "unsupportedPath" });
});
