import * as vscode from "vscode";

/** Native include/exclude rules use the IDE's glob matcher; no command changes its session override. */
export function configuredReadOnly(document: vscode.TextDocument): boolean {
  const configuration = vscode.workspace.getConfiguration("files", document.uri);
  const folder = vscode.workspace.getWorkspaceFolder(document.uri);
  const matches = (key: string): boolean => Object.entries(configuration.get<Record<string, boolean>>(key, {})).some(([pattern, value]) => value === true
    && (vscode.languages.match({ scheme: "file", pattern }, document) > 0
      || !!folder && vscode.languages.match({ scheme: "file", pattern: new vscode.RelativePattern(folder, pattern) }, document) > 0));
  return matches("readonlyInclude") && !matches("readonlyExclude");
}
