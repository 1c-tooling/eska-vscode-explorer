import { test } from "node:test";
import assert from "node:assert/strict";
import { languageUri } from "../out/language/uri.js";

test("LSP URI normalization preserves opaque documents, non-Windows paths and URI decorations", () => {
  for (const value of ["eska-query:/A%3AB", "eska-protected:/C:/Module.bsl", "file:///project/Module.bsl",
    "file:///C:/Module.bsl?query=A", "file:///C:/Module.bsl#A", "file:///c%3A/a%2Fb.bsl"]) {
    assert.equal(languageUri(value), value);
  }
  if (process.platform !== "win32") assert.equal(languageUri("file:///c%3A/Module.bsl"), "file:///c%3A/Module.bsl");
});

test("Windows LSP uses the standard drive and UNC URI without losing Unicode or escaped filename characters", { skip: process.platform !== "win32" }, () => {
  const standard = "file:///C:/Source%20%23/%D0%A2%D0%B5%D1%81%D1%82.bsl";
  assert.equal(languageUri(standard), standard);
  assert.equal(languageUri(standard.replace("C:", "c%3A")), standard);
  assert.equal(languageUri("file://SERVER/share/Module%20A.bsl"), "file://server/share/Module%20A.bsl");
});
