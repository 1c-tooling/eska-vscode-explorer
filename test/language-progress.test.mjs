import { test } from "node:test";
import assert from "node:assert/strict";
import { LanguageProgress } from "../out/language/progress.js";

test("index progress preserves token lifecycles and the latest report while bounding editor traffic", { timeout: 5000 }, async t => {
  const progress = new LanguageProgress(() => true), delivered = [];
  t.after(() => progress.dispose());
  let reported;
  const reports = new Promise(resolve => { reported = resolve; });
  /** Match the language client's callback, which closes over the incoming progress value. */
  const send = (token, value) => progress.handle(token, value, () => {
    delivered.push({ token, ...value });
    if (delivered.length === 4) reported();
  });
  send("index", { kind: "begin", title: "Index", percentage: 0, cancellable: true });
  for (let percentage = 1; percentage <= 75; percentage++) send("index", { kind: "report", percentage });
  send("parse", { kind: "begin", title: "Parse" });
  send("parse", { kind: "report", message: "Parsing" });
  assert.equal(delivered.length, 2);
  await reports;
  assert.deepEqual(delivered.slice(2), [{ token: "index", kind: "report", percentage: 75 }, { token: "parse", kind: "report", message: "Parsing" }]);
  send("index", { kind: "report", percentage: 100 });
  send("index", { kind: "end", message: "Ready" });
  assert.deepEqual(delivered.slice(-2), [{ token: "index", kind: "report", percentage: 100 }, { token: "index", kind: "end", message: "Ready" }]);
  await new Promise(resolve => setTimeout(resolve, 150));
  assert.equal(delivered.length, 6);
});

test("obsolete and disposed language sessions cannot deliver delayed progress", { timeout: 5000 }, async () => {
  let current = true;
  const progress = new LanguageProgress(() => current), delivered = [];
  progress.handle(1, { kind: "report", percentage: 40 }, () => delivered.push(40));
  current = false;
  await new Promise(resolve => setTimeout(resolve, 150));
  progress.handle(1, { kind: "end" }, () => delivered.push("end"));
  current = true;
  progress.handle(2, { kind: "report", percentage: 50 }, () => delivered.push(50));
  progress.dispose();
  progress.handle(3, { kind: "report", percentage: 60 }, () => delivered.push(60));
  await new Promise(resolve => setTimeout(resolve, 150));
  assert.deepEqual(delivered, []);
});
