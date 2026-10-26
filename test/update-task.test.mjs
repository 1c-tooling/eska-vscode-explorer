import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

/** Deliver real task event ordering to the compiled adapter without starting an installer. */
function fixture(start) {
  const processes = new Set(), ends = new Set(), tasks = [];
  const finish = (execution, code) => {
    if (code !== undefined) for (const listener of [...processes]) listener({ execution, exitCode: code });
    for (const listener of [...ends]) listener({ execution });
  };
  const vscode = {
    Task: class { constructor(...args) { this.args = args; } }, ProcessExecution: class { constructor(...args) { this.args = args; } },
    TaskScope: { Global: 1 }, TaskRevealKind: { Always: 1 }, TaskPanelKind: { Dedicated: 1 },
    tasks: {
      onDidEndTaskProcess(listener) { processes.add(listener); return { dispose() { processes.delete(listener); } }; },
      onDidEndTask(listener) { ends.add(listener); return { dispose() { ends.delete(listener); } }; },
      async executeTask(task) { tasks.push(task); return start(finish); },
    },
  };
  const adapter = { exports: {} }, require = createRequire(new URL("../out/tooling/update-task.js", import.meta.url));
  runInNewContext(`(function(require,module,exports){${readFileSync(new URL("../out/tooling/update-task.js", import.meta.url), "utf8")}\n})`, {})(
    name => name === "vscode" ? vscode : require(name), adapter, adapter.exports);
  return { run: adapter.exports.runUpdateTask, processes, ends, tasks };
}

for (const code of [0, 2, undefined]) {
  test(`native update task handles completion before executeTask resolves: ${code}`, async () => {
    const f = fixture(finish => { const task = { terminate() {} }; finish({}, 0); finish(task, code); return task; });
    const operation = f.run("/owned/eska", ["update", "--target-version", "0.16.0"], "Update ESKA", new AbortController().signal);
    if (code === 0) await operation; else await assert.rejects(operation, { code: "updateFailed" });
    assert.equal(f.processes.size, 0); assert.equal(f.ends.size, 0);
    assert.deepEqual([...f.tasks[0].args[4].args[1]], ["update", "--target-version", "0.16.0"]);
  });
}

test("cancellation before task startup terminates only that execution and awaits its completion", async () => {
  const controller = new AbortController(); let terminated = 0;
  const f = fixture(finish => {
    const task = { terminate() { terminated++; finish(task, 1); } };
    controller.abort(); return task;
  });
  await assert.rejects(f.run("/owned/eska", ["update"], "Update", controller.signal), { code: "cancelled" });
  assert.equal(terminated, 1); assert.equal(f.processes.size, 0); assert.equal(f.ends.size, 0);
});

test("task startup failure and pre-cancellation leave no task subscriptions", async () => {
  const f = fixture(() => { throw new Error("task unavailable"); });
  await assert.rejects(f.run("/owned/eska", ["update"], "Update", new AbortController().signal), /task unavailable/);
  await assert.rejects(f.run("/owned/eska", ["update"], "Update", AbortSignal.abort()), { code: "cancelled" });
  assert.equal(f.tasks.length, 1); assert.equal(f.processes.size, 0); assert.equal(f.ends.size, 0);
});
