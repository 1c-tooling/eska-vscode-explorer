const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const vscode = require('vscode');

/** Bound activation waits so an unexpected installation dialog fails the acceptance run. */
async function until(predicate, message) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error(message);
}

/** Open with a compatible development backend while PATH contains an incompatible global CLI. */
exports.run = async function () {
  const fixture = JSON.parse(process.env.ESKA_HOST_FIXTURE);
  assert.ok(process.env.ESKA_HOST_GLOBAL_BINARY, 'a separate incompatible global CLI is required');
  const extension = vscode.extensions.all.find(value => value.packageJSON.name === 'eska-explorer');
  assert.ok(extension);
  const explorer = await extension.activate();
  await until(() => explorer.connection.state.kind === 'ready', 'configured backend connected without a global installation dialog');
  assert.equal(explorer.connection.state.target.executable, process.env.ESKA_TEST_BINARY);
  const [root] = await explorer.getChildren();
  assert.ok(root?.node);
  const schema = await explorer.tree.request(root.project, 'metadata/propertyEditing', { objectId: root.node.id.objectId });
  assert.ok(Array.isArray(schema.fields), 'property editing schema is available');

  // Explicitly selecting the incompatible CLI must fail its handshake, with no fallback.
  await vscode.workspace.getConfiguration('eska.explorer').update('executable', process.env.ESKA_HOST_GLOBAL_BINARY, vscode.ConfigurationTarget.Workspace);
  await vscode.commands.executeCommand('eska.explorer.restart');
  await until(() => explorer.connection.state.kind === 'error', 'incompatible override is rejected');
  assert.equal(explorer.connection.state.error.code, 'incompatible');
  await vscode.workspace.getConfiguration('eska.explorer').update('executable', process.env.ESKA_TEST_BINARY, vscode.ConfigurationTarget.Workspace);
  await vscode.commands.executeCommand('eska.explorer.restart');
  await until(() => explorer.connection.state.kind === 'ready', 'compatible override reconnects');
  await vscode.commands.executeCommand('eska.explorer.disconnect');
  await fs.writeFile(path.join(fixture.root, 'host-result.json'), JSON.stringify({ passed: true, suite: 'backend-override', vscode: vscode.version }));
};
