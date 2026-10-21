const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const { createRequire } = require("node:module");
const vscode = require("vscode");

/** Use the editor's own grammar engine, avoiding a second development-only TextMate/Oniguruma installation. */
exports.run = async function () {
  const fixture = JSON.parse(process.env.ESKA_HOST_FIXTURE);
  const extension = vscode.extensions.all.find(value => value.packageJSON.name === "eska-explorer");
  const requireEditor = createRequire(path.join(vscode.env.appRoot, "package.json"));
  const textmate = requireEditor("vscode-textmate"), oniguruma = requireEditor("vscode-oniguruma");
  const wasm = await fs.readFile(path.join(path.dirname(requireEditor.resolve("vscode-oniguruma")), "onig.wasm"));
  await oniguruma.loadWASM(wasm.buffer.slice(wasm.byteOffset, wasm.byteOffset + wasm.byteLength));
  const registry = new textmate.Registry({
    onigLib: Promise.resolve({ createOnigScanner: patterns => new oniguruma.OnigScanner(patterns), createOnigString: text => new oniguruma.OnigString(text) }),
    async loadGrammar(scope) {
      const language = scope === "source.bsl" ? "bsl" : scope === "source.sdbl" ? "sdbl" : undefined;
      if (!language) return null;
      const file = path.join(extension.extensionPath, "resources/language", language + ".tmLanguage.json");
      return textmate.parseRawGrammar(await fs.readFile(file, "utf8"), file);
    },
  });
  const bsl = await registry.loadGrammar("source.bsl"), sdbl = await registry.loadGrammar("source.sdbl");
  /** Assert scopes at source offsets rather than merely checking that a JSON field exists. */
  function has(grammar, line, word, scope) {
    const offset = line.indexOf(word); assert.ok(offset >= 0);
    const token = grammar.tokenizeLine(line, textmate.INITIAL).tokens.find(value => value.startIndex <= offset && value.endIndex > offset);
    assert.ok(token?.scopes.includes(scope), `${word}: ${JSON.stringify(token)}`);
  }
  has(bsl, "Функция Проверка(Значение) Экспорт", "Функция", "keyword.control.bsl");
  has(bsl, "функция Проверка()", "функция", "keyword.control.bsl");
  has(bsl, "Async Function Check() Export", "Async", "keyword.control.bsl");
  has(bsl, 'Текст = "// не комментарий"; // комментарий', "не комментарий", "string.quoted.double.bsl");
  has(bsl, "// Проверка", "Проверка", "comment.line.double-slash.bsl");
  has(bsl, "Дата = '20261021';", "20261021", "constant.other.date.bsl");
  has(sdbl, "ВЫБРАТЬ Товары.Ссылка ИЗ Справочник.Товары", "ВЫБРАТЬ", "keyword.control.sdbl");
  has(sdbl, "SELECT Ref FROM Catalog.Items WHERE Ref = &Ссылка", "SELECT", "keyword.control.sdbl");
  has(sdbl, "ГДЕ Ссылка = &Параметр", "&Параметр", "variable.parameter.sdbl");
  const file = path.join(fixture.root, "grammar.sdbl"); await fs.writeFile(file, "ВЫБРАТЬ 1");
  assert.equal((await vscode.workspace.openTextDocument(vscode.Uri.file(file))).languageId, "sdbl");
  registry.dispose();
  await fs.writeFile(path.join(fixture.root, "host-result.json"), JSON.stringify({ passed: true, suite: "grammar",
    vscode: vscode.version, textmate: requireEditor("vscode-textmate/package.json").version,
    oniguruma: requireEditor("vscode-oniguruma/package.json").version, scopes_checked: 9 }));
};
