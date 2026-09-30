import { test } from "node:test";
import assert from "node:assert/strict";
import { picturePreview } from "../out/picture.js";

test("picture transport accepts only bounded base64 image data", () => {
  const ready = { status: "ready", mimeType: "image/svg+xml", data: "PHN2Zy8+", fileName: "Picture.svg" };
  assert.deepEqual(picturePreview(ready), ready);
  assert.equal(picturePreview(undefined), undefined);
  for (const bad of [null, {}, { ...ready, mimeType: "text/html" }, { ...ready, data: "data:evil" },
    { ...ready, data: "" }, { ...ready, data: "====" }, { ...ready, data: "a".repeat(11_184_816) }]) {
    assert.equal(picturePreview(bad).status, "invalid");
  }
  for (const status of ["missing", "unsupported", "invalid", "too_large", "unavailable"]) {
    assert.deepEqual(picturePreview({ status }), { status });
  }
});
