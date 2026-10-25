/** Measure reverse navigation against a real backend, with owned synthetic projects only. */
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { Connection } from "../out/connection.js";
import { MetadataTree } from "../out/tree.js";
import { revealFile } from "../out/reveal.js";
import { createTreeProject } from "./fixture.mjs";

const executable = process.env.ESKA_TEST_BINARY;
assert.ok(executable, "Set ESKA_TEST_BINARY to an optimized eska-project binary.");
const root = await mkdtemp(join(process.env.ESKA_TEST_ROOT ?? resolve("../eska-playground"), "reveal-bench-"));
try {
  for (const count of [100, 2000, 10000]) {
    const fixture = await createTreeProject(join(root, String(count)));
    const descriptor = join(fixture.source, "Configuration.xml");
    const original = await readFile(descriptor, "utf8");
    await writeFile(descriptor, original.replace("<ChildObjects>", "<ChildObjects>" + Array.from({ length: count - 2 }, (_, i) => `<Catalog>Item${i}</Catalog>`).join("")));
    for (let run = 0; run < 5; run++) {
      const connection = new Connection("benchmark", () => {}, () => {});
      try {
        await connection.connect({ executable, path: fixture.root, name: "benchmark", locale: "ru-RU" });
        assert.equal(connection.state.kind, "ready");
        const tree = new MetadataTree(connection, connection.state.session, () => {}, () => {});
        const request = connection.request.bind(connection);
        let requests = 0;
        connection.request = (...args) => { requests++; return request(...args); };
        const samples = [];
        for (let sample = 0; sample < 31; sample++) {
          requests = 0;
          const start = performance.now();
          const entry = await revealFile(tree, fixture.module);
          const elapsed = performance.now() - start;
          assert.equal(entry.node.id.kind, "module");
          samples.push({ ms: elapsed, requests, retainedNodes: tree.projects[0].nodes.size });
        }
        const warm = samples.slice(1).map(sample => sample.ms).sort((a, b) => a - b);
        console.log(JSON.stringify({ count, run, cold: samples[0], warmMedianMs: warm[14], warmP95Ms: warm[28], warmRequests: samples[1].requests }));
        tree.dispose();
      } finally { await connection.dispose(); }
    }
  }
} finally { await rm(root, { recursive: true, force: true }); }
