import { test } from "node:test";
import assert from "node:assert/strict";
import { gitStatus } from "../out/git-status.js";

test("Git statuses use theme colors and conflict priority without painting ignored files", () => {
  assert.equal(gitStatus(0).color, "stageModifiedResourceForeground");
  assert.equal(gitStatus(5).color, "modifiedResourceForeground");
  assert.equal(gitStatus(7).badge, "U");
  assert.equal(gitStatus(1).badge, "A");
  assert.equal(gitStatus(3).badge, "R");
  assert.equal(gitStatus(6).badge, "D");
  assert.equal(gitStatus(8), undefined);
  for (let status = 12; status <= 18; status++) {
    assert.equal(gitStatus(status).color, "conflictingResourceForeground");
    assert.ok(gitStatus(status).priority > gitStatus(6).priority);
  }
  assert.equal(gitStatus(999), undefined);
});
