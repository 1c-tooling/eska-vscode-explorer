const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const vscode = require('vscode');

/** Click identical subscription names in separate projects and verify the native editor selection. */
exports.run = async function () {
  const fixture = JSON.parse(process.env.ESKA_HOST_FIXTURE);
  const { createTreeProject, addCommonModules, descriptor } = await import('./fixture.mjs');
  for (const type of ['configuration', 'extension']) {
    const member = await createTreeProject(path.join(fixture.root, type), type);
    await fs.writeFile(path.join(member.root, 'eska.toml'), `[project]\nname='${type}'\ntype='${type}'\n`);
    await addCommonModules(member);
    const root = path.join(member.source, 'Configuration.xml');
    await fs.writeFile(root, (await fs.readFile(root, 'utf8')).replace('<ChildObjects>', '<ChildObjects><EventSubscription>ПриЗаписи</EventSubscription>'));
    await fs.mkdir(path.join(member.source, 'EventSubscriptions'));
    await fs.writeFile(path.join(member.source, 'EventSubscriptions', 'ПриЗаписи.xml'),
      descriptor('EventSubscription', 'ПриЗаписи', '', '<Handler>CommonModule.Обмен.ПриЗаписи</Handler>'));
    await fs.writeFile(path.join(member.source, 'CommonModules', 'Обмен', 'Ext', 'Module.bsl'),
      `\ufeff// 😀 ${type}\r\nПроцедура ПриЗаписи(Источник) Экспорт\r\nКонецПроцедуры\r\n`);
  }
  await fs.writeFile(path.join(fixture.root, 'eska.toml'), '[workspace]\nmembers=["configuration", "extension"]\n');
  await vscode.workspace.getConfiguration('eska.explorer').update('executable', process.env.ESKA_TEST_BINARY, vscode.ConfigurationTarget.Workspace);
  const extension = vscode.extensions.all.find(value => value.packageJSON.name === 'eska-explorer');
  const explorer = await extension.activate();
  await vscode.commands.executeCommand('eska.explorer.connect');
  const roots = (await explorer.getChildren()).filter(entry => entry.node);
  assert.equal(roots.length, 2);
  for (const root of roots) {
    const common = (await explorer.getChildren(root)).find(e => e.node?.id.collection?.kind === 'common');
    const group = (await explorer.getChildren(common)).find(e => e.node?.id.collection?.metadataKind === 'event-subscription');
    const [entry] = await explorer.getChildren(group);
    const command = explorer.getTreeItem(entry).command;
    await vscode.commands.executeCommand(command.command, ...command.arguments);
    const editor = vscode.window.activeTextEditor;
    assert.equal(editor.document.uri.fsPath, path.join(fixture.root, root.project.info.type, 'src', 'CommonModules', 'Обмен', 'Ext', 'Module.bsl'));
    assert.equal(editor.document.getText(editor.selection), 'ПриЗаписи');
    assert.equal(editor.selection.start.line, 1);
    await vscode.commands.executeCommand('eska.explorer.openXml', entry);
    assert.equal(vscode.window.activeTextEditor.document.uri.fsPath,
      path.join(fixture.root, root.project.info.type, 'src', 'EventSubscriptions', 'ПриЗаписи.xml'));
  }
  await vscode.commands.executeCommand('eska.explorer.disconnect');
  await fs.writeFile(path.join(fixture.root, 'host-result.json'), JSON.stringify({ passed: true, suite: 'event-handler', projects: 2, vscode: vscode.version }));
};
