import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

/** This inactive fixture tests the real extension registry, not the third-party language engine. */
export async function createConflictFixture(root) {
  const folder = join(root, "conflict-extension"), vsix = join(root, "conflict-fixture.vsix");
  await mkdir(folder);
  await writeFile(join(folder, "package.json"), JSON.stringify({ name: "bsl-analyzer-lsp", publisher: "elishevkirill", version: "0.0.1",
    displayName: "ESKA test conflict fixture", description: "Isolated extension registry fixture", license: "UNLICENSED",
    engines: { vscode: "^1.109.0" }, main: "./extension.cjs", activationEvents: ["onCommand:eskaConflictFixture.activate"],
    contributes: { commands: [{ command: "eskaConflictFixture.activate", title: "ESKA test: activate conflict fixture" }] } }));
  await writeFile(join(folder, "extension.cjs"), "exports.activate = () => ({ fixture: true });\n");
  await writeFile(join(folder, "README.md"), "# Isolated test fixture\nNo language server is included or started.\n");
  await writeFile(join(folder, "LICENSE"), "Test fixture; not for distribution.\n");
  await writeFile(join(folder, ".vscodeignore"), "**\n!package.json\n!extension.cjs\n!README.md\n!LICENSE\n");
  const repository = fileURLToPath(new URL("../", import.meta.url));
  await promisify(execFile)(process.execPath, [resolve(repository, "node_modules/@vscode/vsce/vsce"), "package", "--no-dependencies",
    "--no-rewrite-relative-links", "--allow-missing-repository", "--out", vsix], { cwd: folder, timeout: 60000 });
  return { folder, vsix };
}
