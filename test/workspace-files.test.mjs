import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm, symlink } from "node:fs/promises";
import { join, resolve } from "node:path";
import { WorkspaceFiles, fileCategory } from "../out/workspace-files.js";

/** Use the same decoded paths as a real IDE project, without coupling filesystem tests to a subprocess. */
function project(root, source = join(root, "src"), member = false) {
  return { info: { rootPath: { value: root, encoding: "utf-8" }, sourcePath: { value: source, encoding: "utf-8" },
    scope: member ? { kind: "member", name: root.split(/[\\/]/).at(-1) } : { kind: "standalone" } } };
}

/** All files belong to this test's unique playground fixture. */
async function fixture(t) {
  const root = await mkdtemp(join(process.env.ESKA_TEST_ROOT ?? resolve("../eska-playground"), "explorer-files-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

/** Record watched directories and drive the same invalidation callback that native watchers use. */
function model(t, projects, root) {
  const watches = new Map();
  const changes = [];
  const files = new WorkspaceFiles(projects, root, (path, changed) => {
    watches.set(path, changed);
    return { dispose: () => watches.delete(path) };
  }, entry => changes.push(entry));
  t.after(() => files.dispose());
  return { files, watches, changes };
}

/** Write only immediate fixture entries, leaving traversal assertions observable. */
async function populate(root, names) {
  await mkdir(root, { recursive: true });
  for (const name of names) await writeFile(join(root, name), name);
}

test("settings ownership and README languages do not rename physical files", () => {
  for (const name of ["eska.toml", ".gitignore"]) assert.equal(fileCategory(name, false), "settings");
  for (const name of [".gitattributes", "bsl-analyzer.toml", ".bsl-language-server.json",
    ".gitmodules", ".lfsconfig", ".mailmap", "AGENTS.md", "AGENTS.override.md", "CLAUDE.md",
    ".cursorrules", ".editorconfig", ".gitlab-ci.yml", "demo.code-workspace"]) {
    assert.equal(fileCategory(name, false), "settings");
    assert.equal(fileCategory(name, true), "other");
  }
  for (const name of [".codex", ".agents", ".claude", ".cursor", ".vscode", ".github", ".gitlab", ".gitea", ".forgejo"]) {
    assert.equal(fileCategory(name, true), "settings");
    assert.equal(fileCategory(name, false), "other");
  }
  for (const name of [".git", ".eska", ".unknown", "notes.md", "demo.code-workspace.bak"]) {
    assert.equal(fileCategory(name, false), "other");
    assert.equal(fileCategory(name, true), "other");
  }
  for (const name of ["README.md", "README.ru.md", "README.en.md", "readme.pt-BR.md"]) {
    assert.equal(fileCategory(name, false), "documentation");
  }
  assert.equal(fileCategory("README.md.bak", false), "other");
  assert.equal(fileCategory("README.md", true), "other");
});

test("standalone categories are lazy, files keep names, and source trees are excluded", async t => {
  const root = await fixture(t);
  await populate(root, ["eska.toml", ".gitignore", ".gitattributes", "bsl-analyzer.toml", ".bsl-language-server.json", "README.md", "README.ru.md", "notes.txt"]);
  for (const dir of ["src", "build", ".git", "assets"]) await mkdir(join(root, dir));
  await populate(join(root, "build"), ["demo.cf"]);
  await populate(join(root, ".git"), ["config"]);
  const info = project(root);
  const { files, watches } = model(t, [info], root);
  assert.deepEqual(await files.groups(info), [], "standalone files belong beside the configuration");
  assert.equal(watches.size, 0);
  const groups = await files.groups();
  assert.deepEqual(groups.map(group => group.kind), ["settings", "documentation", "other"]);
  assert.deepEqual([...watches.keys()], [root]);
  const settings = await files.children(groups[0]);
  assert.equal(settings.length, 5);
  assert.ok(settings.every(entry => entry.parent === groups[0]));
  const other = await files.children(groups[2]);
  assert.ok(!other.some(entry => entry.path === join(root, "src")));
  assert.ok(other.some(entry => entry.path === join(root, ".git")));
  assert.equal(watches.size, 1, "collapsed Git and build directories are not watched or scanned");
  const build = await files.reveal(join(root, "build/demo.cf"));
  assert.equal(build.path, join(root, "build/demo.cf"));
  assert.equal(build.parent.parent.kind, "other");
  const git = await files.reveal(join(root, ".git/config"));
  assert.equal(git.parent.parent.kind, "other");
  assert.equal(await files.reveal(join(root + "-other", "notes.txt")), undefined);
});

test("workspace separates global settings and members, even when nested outside src", async t => {
  const root = await fixture(t);
  const first = project(join(root, "src/first"), join(root, "src/first/xml"), true);
  const second = project(join(root, "tools/second"), join(root, "tools/second/src"), true);
  await populate(root, ["eska.toml", ".gitattributes", "bsl-analyzer.toml", ".bsl-language-server.json", "README.md"]);
  for (const p of [first, second]) {
    await populate(p.info.rootPath.value, ["eska.toml", ".gitignore", ".gitattributes", "bsl-analyzer.toml", ".bsl-language-server.json", "README.en.md"]);
    await mkdir(p.info.sourcePath.value);
  }
  for (const scope of [root, first.info.rootPath.value]) {
    await populate(scope, ["AGENTS.md", "demo.code-workspace"]);
    await populate(join(scope, ".codex"), ["config.toml", "README.md"]);
    await populate(join(scope, ".github/workflows"), ["check.yml"]);
  }
  await populate(join(root, "src"), ["README.ru.md"]);
  const { files } = model(t, [first, second], root);
  assert.ok(files.scopes.some(scope => scope.path === root && !scope.project));
  assert.equal((await files.groups()).some(group => group.kind === "structure"), false);
  const member = await files.groups(first);
  assert.equal((await files.children(member.find(group => group.kind === "settings"))).length, 9);
  const attrs = await files.reveal(join(first.info.rootPath.value, ".gitattributes"));
  assert.equal(attrs.parent.kind, "settings");
  assert.equal(attrs.parent.scope.project, first);
  const global = await files.reveal(join(root, "bsl-analyzer.toml"));
  assert.equal(global.parent.scope.project, undefined);
  assert.equal(global.parent.kind, "settings");
  for (const scope of [root, first.info.rootPath.value]) {
    const lsp = await files.reveal(join(scope, ".bsl-language-server.json"));
    assert.equal(lsp.parent.kind, "settings");
  }
  for (const [scope, owner] of [[root, undefined], [first.info.rootPath.value, first]]) {
    for (const name of ["AGENTS.md", "demo.code-workspace", ".codex/README.md", ".github/workflows/check.yml"]) {
      const entry = await files.reveal(join(scope, name));
      assert.equal(entry.path, join(scope, name));
      let parent = entry.parent;
      while (parent.fileKind === "entry") parent = parent.parent;
      assert.equal(parent.kind, "settings");
      assert.equal(parent.scope.project, owner);
    }
    const other = (await files.groups(owner)).find(group => group.kind === "other");
    if (other) assert.ok(!(await files.children(other)).some(entry => [".codex", ".github"].includes(entry.path.split(/[\\/]/).at(-1))));
  }
  const src = (await files.children((await files.groups()).find(group => group.kind === "other"))).find(entry => entry.path === join(root, "src"));
  assert.deepEqual((await files.children(src)).map(entry => entry.path), [join(root, "src/README.ru.md")]);
  assert.equal(await files.reveal(join(first.info.sourcePath.value, "Configuration.xml")), undefined);
  const direct = model(t, [first], first.info.rootPath.value).files;
  assert.deepEqual(await direct.groups(), [], "opening one member does not expose its parent workspace");
});

test("watch invalidation reveals new groups and removal; manual refresh recovers unwatched events", async t => {
  const root = await fixture(t);
  await populate(root, ["eska.toml"]);
  const p = project(root);
  const { files, watches, changes } = model(t, [p], root);
  assert.deepEqual((await files.groups()).map(group => group.kind), ["settings"]);
  await populate(root, ["README.md"]);
  assert.equal((await files.groups()).length, 1, "reuse the shallow snapshot until invalidation");
  await watches.get(root)();
  assert.deepEqual(changes, [undefined]);
  assert.equal((await files.groups()).length, 2);
  await watches.get(root)();
  assert.equal(changes.length, 1, "late events with unchanged names do not reset native selection");
  await rm(join(root, "README.md"));
  files.refresh();
  assert.equal((await files.groups()).length, 1);
  files.dispose();
  assert.equal(watches.size, 0);
});

test("directory links remain navigable but ancestor cycles terminate", { skip: process.platform === "win32" }, async t => {
  const root = await fixture(t);
  await populate(root, ["eska.toml"]);
  await mkdir(join(root, "assets"));
  await symlink(root, join(root, "assets/back"));
  const p = project(root);
  const { files } = model(t, [p], root);
  const other = (await files.groups()).find(group => group.kind === "other");
  const [assets] = await files.children(other);
  const [back] = await files.children(assets);
  assert.equal(back.link, true);
  assert.deepEqual(await files.children(back), []);
});
