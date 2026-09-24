const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const vscode = require('vscode');
const { readonlyPatterns } = require('../out/support-settings.js');

/** Validate compact alternatives with the editor's actual glob matcher and native typing. */
exports.run = async function () {
  const fixture = JSON.parse(process.env.ESKA_HOST_FIXTURE);
  const explorer = await vscode.extensions.all.find(value => value.packageJSON.name === 'eska-explorer').activate();
  await vscode.commands.executeCommand('eska.explorer.disconnect');
  await explorer.support.serial;
  const locked = path.join(fixture.root, 'literal,a[1].bsl');
  const allowed = path.join(fixture.root, 'literal,a1.bsl');
  await fs.writeFile(locked, '// original\n');
  await fs.writeFile(allowed, '// original\n');
  const nestedLocked = path.join(fixture.root, 'Catalogs/A/Ext/ObjectModule.bsl');
  const nestedAllowed = path.join(fixture.root, 'Catalogs/A/Ext/ManagerModule.bsl');
  const otherLocked = path.join(fixture.root, 'Catalogs/B/Ext/ManagerModule.bsl');
  for (const file of [nestedLocked, nestedAllowed, otherLocked]) {
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, '// original\n');
  }
  const cyrillicLocked = path.join(fixture.root, 'CommonModules/АвансовыйОтчетФормы/Ext/Module.bsl');
  await fs.mkdir(path.dirname(cyrillicLocked), { recursive: true });
  await fs.writeFile(cyrillicLocked, '// original\n');
  const longNames = Array.from({ length: 128 }, (_, i) => path.join(fixture.root,
    `CommonModules/АяДлинноеНаименованиеОбщегоМодуля${String(i).padStart(3, '0')}/Ext/Module.bsl`));
  const patterns = readonlyPatterns(fixture.root, [locked, nestedLocked, otherLocked, cyrillicLocked,
    ...longNames, ...Array.from({length:256}, (_, i) => path.join(fixture.root, `Module${i}.bsl`))]);
  assert.ok(patterns.some(pattern => pattern.includes('/CommonModules/') && pattern.includes('вансовыйОтчетФормы')));
  assert.ok(patterns.every(pattern => pattern.length <= 4096));
  await vscode.workspace.getConfiguration('files').update('readonlyInclude', Object.fromEntries(patterns.map(pattern => [pattern,true])), vscode.ConfigurationTarget.Workspace);
  for (const file of [locked, allowed, nestedLocked, nestedAllowed, otherLocked, cyrillicLocked]) {
    const editor = await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(vscode.Uri.file(file)));
    const before = editor.document.getText();
    await vscode.commands.executeCommand('type', {text:'// edit\n'});
    assert.equal(editor.document.getText() === before, [locked, nestedLocked, otherLocked, cyrillicLocked].includes(file), file);
    await vscode.commands.executeCommand('workbench.action.revertAndCloseActiveEditor');
  }
  await fs.writeFile(path.join(fixture.root, 'host-result.json'), JSON.stringify({passed:true, compactLiteralPatterns:true, adjacentFileEditable:true}));
};
