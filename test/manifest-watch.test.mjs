import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdtemp, mkdir, rm, writeFile, appendFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { runInNewContext } from "node:vm";
import { deferCleanup } from "./cleanup.mjs";

/** Only the editor boundary is absent: Node's real file polling observes actual owned files. */
function load(fs) {
  const require = createRequire(new URL("../out/watch.js", import.meta.url)), module = { exports: {} };
  runInNewContext(`(function(require,module,exports){${readFileSync(new URL("../out/watch.js", import.meta.url), "utf8")}\n})`, { setTimeout, clearTimeout })(
    name => name === "vscode" ? {} : name === "./source.js" ? { nativePath: value => value.value }
      : name === "node:fs" && fs ? fs : require(name), module, module.exports);
  return module.exports.watchManifests;
}

async function until(predicate) {
  const deadline = Date.now() + 5000;
  while (!predicate()) {
    assert.ok(Date.now() < deadline, "manifest observation timed out");
    await new Promise(done => setTimeout(done, 20));
  }
}

test("manifest polling catches immediate edits and missing-parent creation, and stops on disposal", async t => {
  const owner = await mkdtemp(join(process.env.ESKA_TEST_ROOT ?? resolve("../eska-playground"), "explorer-manifest-"));
  deferCleanup(t, () => rm(owner, { recursive: true, force: true }));
  const start = join(owner, "initially missing", "child"), file = join(start, "eska.toml");
  let observed = 0, changed = 0;
  const watcher = load()(start, [], () => changed++, () => observed++);
  deferCleanup(t, () => watcher.dispose());
  await new Promise(done => setTimeout(done, 50));
  assert.equal(observed, 0, "missing-file registration is not a change");
  await mkdir(start, { recursive: true });
  await writeFile(file, "[project]\ntype='report'\n");
  await until(() => changed === 1);
  await appendFile(file, "# written immediately after the previous observation\n");
  await until(() => changed === 2);
  watcher.dispose();
  const before = observed;
  await appendFile(file, "# after disposal\n");
  await new Promise(done => setTimeout(done, 1200));
  assert.equal(observed, before);
});

test("queued callbacks after disposal cannot reconnect and unwatch releases only its own listeners", async () => {
  const listeners = [], removed = [];
  const watcher = load({ watchFile(path, options, listener) { listeners.push({ path, options, listener }); },
    unwatchFile(path, listener) { removed.push({ path, listener }); } })(resolve("../eska-playground/dto"), [],
      () => assert.fail("disposed timer reconnected"), () => assert.fail("disposed callback observed"));
  assert.ok(listeners.length > 1);
  watcher.dispose();
  assert.equal(removed.length, listeners.length);
  for (const [index, value] of listeners.entries()) {
    assert.equal(value.options.persistent, false);
    assert.equal(value.options.interval, 1000);
    assert.equal(removed[index].listener, value.listener);
    value.listener({ mtimeMs: 1 }, { mtimeMs: 0 });
  }
  await new Promise(done => setTimeout(done, 180));
});
