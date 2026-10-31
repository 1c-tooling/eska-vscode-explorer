import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

test("native directory decoration feedback is bounded and a later file receives current protection", async()=>{
  const {stdout}=await promisify(execFile)("node",[fileURLToPath(new URL("./support-directories.cjs",import.meta.url))],{timeout:10000});
  assert.deepEqual(JSON.parse(stdout),{passed:true,directory_feedback_stopped:true,file_transition_checked:true});
});
