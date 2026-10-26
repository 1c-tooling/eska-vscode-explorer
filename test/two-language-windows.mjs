import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createTreeProject } from "./fixture.mjs";
import { createLanguageSource, createLanguageSupportSource } from "./language-fixture.mjs";

const repository = fileURLToPath(new URL("../", import.meta.url));
const playground = process.env.ESKA_TEST_ROOT ?? resolve(repository, "../eska-playground");
assert.ok(isAbsolute(playground));
const memberOnly = process.env.ESKA_HOST_MEMBER_CONTEXT === "1";
const stand = await mkdtemp(join(playground, memberOnly ? "t88-member-context-" : "t88-two-language-windows-"));
const workspace = join(stand, "workspace"), coordination = join(stand, "signals");
await mkdir(workspace); await mkdir(coordination);
const files = {}, names = { one: "ИзПервогоПриложения", two: "ИзВторогоПриложения" };
for (const [member, application] of [["a", "one"], ["b", "two"]]) {
  const fixture = await createTreeProject(join(workspace, member));
  await writeFile(join(fixture.root, "eska.toml"), `[project]\nname='${member}'\ntype='configuration'\n`);
  const { file, text } = await (memberOnly ? createLanguageSupportSource(fixture) : createLanguageSource(fixture));
  await writeFile(file, text.replaceAll("Проверка", names[application]) + (memberOnly ? "" : "Функция Сломано(\n"));
  files[application] = file;
}
await writeFile(join(workspace, "eska.toml"), "[workspace]\n[analysis]\ndefault_application='one'\n[workspace.members.one]\nconfiguration='a'\n[workspace.members.two]\nconfiguration='b'\n");
await writeFile(join(coordination, "fixture.json"), JSON.stringify({ workspace, files, names }));

/** Each role has its own native profile and extension host but shares the actual managed config and OS lock. */
async function launch(role) {
  const suite = role === "member" ? "test/language-member-context-host.cjs" : "test/language-context-window-host.cjs";
  const child = spawn(process.execPath, ["test/run-host.mjs", suite], {
    cwd: repository, env: { ...process.env, ESKA_TEST_LANGUAGE: "1", ESKA_HOST_SUPPORT_DISABLED: "1",
      ESKA_PERF_PROJECT: role === "member" ? join(workspace, "a") : workspace, ESKA_HOST_COORDINATION: coordination, ESKA_HOST_WINDOW_ROLE: role,
      ESKA_HOST_LOG: join(stand, `window-${role}-raw.log`) }, stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  /** Keep diagnostics bounded; all native assertions publish an explicit machine-readable result. */
  const capture = data => { output = (output + data.toString()).slice(-160000); };
  child.stdout.on("data", capture); child.stderr.on("data", capture);
  const code = await new Promise((done, fail) => { child.once("error", fail); child.once("close", done); });
  await writeFile(join(stand, `window-${role}.log`), output);
  assert.equal(code, 0, `window ${role}: ${output.slice(0, 16000)}`);
  const result = output.split(/\r?\n/).filter(line => line.startsWith("{")).map(line => JSON.parse(line)).find(value => value.passed && value.role === role);
  assert.ok(result, `missing window ${role} result`);
  return result;
}

const outcomes = await Promise.allSettled(memberOnly ? [launch("member")] : [launch("a"), launch("b")]);
const results = outcomes.filter(value => value.status === "fulfilled").map(value => value.value);
const failures = outcomes.filter(value => value.status === "rejected").map(value => String(value.reason.stack ?? value.reason));
const report = { passed: failures.length === 0 && results.length === (memberOnly ? 1 : 2), suite: memberOnly ? "language-member-context" : "two-language-windows", stand, results, failures,
  scope: memberOnly ? "Native editor opened at member A, with application sources in member B outside the metadata selection."
    : "Two simultaneous native editor profiles, real project servers, published analyzer and OS config leases. Selection is supplied to the production controller; no keyboard automation." };
await writeFile(join(stand, "report.json"), JSON.stringify(report, null, 2) + "\n");
console.log(JSON.stringify({ ...report, failures: failures.map(value => value.slice(0, 5000)) }));
if (!report.passed) process.exitCode = 1;
