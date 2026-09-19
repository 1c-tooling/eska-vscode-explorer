const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const vscode = require('vscode');

/** Leave a live backend to native host shutdown; the parent runner verifies that its PID exits. */
exports.run = async function () {
  const fixture = JSON.parse(process.env.ESKA_HOST_FIXTURE);
  const explorer = await vscode.extensions.all.find(value => value.packageJSON.name === 'eska-explorer').activate();
  await vscode.commands.executeCommand('eska.explorer.connect');
  assert.equal(explorer.connection.state.kind, 'ready');
  const pid = explorer.connection.child.pid;
  process.kill(pid, 0);
  await vscode.commands.executeCommand('eska.explorer.search');
  assert.ok(explorer.searchView);
  await fs.writeFile(path.join(fixture.root, 'host-result.json'), JSON.stringify({
    passed: true, suite: 'shutdown', vscode: vscode.version, shutdownPids: [pid],
  }));
};
