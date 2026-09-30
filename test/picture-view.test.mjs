import { test } from "node:test";
import assert from "node:assert/strict";
import { createPictureView } from "../resources/properties/picture.mjs";

/** Provide image events explicitly so superseded decodes can finish in any order. */
function fixture() {
  class Element extends EventTarget {
    hidden = false;
    isConnected = true;
    textContent = "";
    naturalWidth = 64;
    naturalHeight = 32;
    attributes = new Map();
    classList = { toggle() {} };
    setAttribute(key, value) { this.attributes.set(key, value); }
    prepend(element) { element.isConnected = true; }
    remove() { this.isConnected = false; }
  }
  const nodes = new Map(["picture-preview", "picture-frame", "picture-caption", "picture-status", ".page"]
    .map(id => [id, new Element()]));
  const images = [];
  const document = { getElementById: id => nodes.get(id), querySelector: id => nodes.get(id),
    createElement: () => { const image = new Element(); images.push(image); return image; } };
  return { view: createPictureView(document), images, nodes };
}

/** Use distinct bytes and labels to identify accidental publication from an older image. */
function snapshot(data = "YWJj", overrides = {}) {
  return { title: "Icon", labels: { picture: "Preview", pictureLoading: "Loading", pictureInvalid: "Invalid", pictureMissing: "Missing" },
    picture: { status: "ready", mimeType: "image/png", fileName: "100.png", data }, ...overrides };
}

test("removed image events cannot replace a newer preview or revive a hidden preview", () => {
  const { view, images, nodes } = fixture();
  view.render(snapshot());
  const old = images[0];
  view.render(snapshot("bmV3"));
  old.dispatchEvent(new Event("load"));
  assert.equal(nodes.get("picture-caption").textContent, "");
  images[1].dispatchEvent(new Event("load"));
  assert.equal(nodes.get("picture-caption").textContent, "PNG · 64 × 32");
  old.dispatchEvent(new Event("error"));
  assert.equal(nodes.get("picture-status").hidden, true);
  view.render(snapshot("", { picture: undefined }));
  images[1].dispatchEvent(new Event("load"));
  assert.equal(nodes.get("picture-preview").hidden, true);
  assert.equal(nodes.get("picture-caption").textContent, "");
});

test("identical bytes retain the image while filename, title and error labels stay current", () => {
  const { view, images, nodes } = fixture();
  const state = snapshot();
  view.render(state);
  images[0].dispatchEvent(new Event("error"));
  view.render({ ...state, title: "Updated", labels: { ...state.labels, pictureInvalid: "Не удалось показать" } });
  assert.equal(images.length, 1);
  assert.equal(images[0].alt, "Updated");
  assert.equal(nodes.get("picture-status").textContent, "Не удалось показать");
  view.render(snapshot("", { picture: { status: "loading" } }));
  view.render(state);
  assert.equal(images.length, 2, "refresh retries a failed decode");
  images[1].dispatchEvent(new Event("load"));
  view.render({ ...state, picture: { ...state.picture, fileName: "renamed.png" } });
  assert.equal(images.length, 2);
  assert.equal(images[1].title, "renamed.png · 64 × 32");
  view.render(snapshot("", { picture: { status: "missing" } }));
  assert.equal(nodes.get("picture-status").textContent, "Missing");
  assert.equal(nodes.get("picture-caption").textContent, "");
});
