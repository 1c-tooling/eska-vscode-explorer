const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const vscode = require('vscode');

/** Hold the actual backend open request without replacing discovery or the connection controller. */
function barrier() {
  let release;
  const promise = new Promise(resolve => { release = resolve; });
  return { promise, release };
}

/** Connect during an unfinished handshake must join it; explicit restart must still replace its process. */
exports.run = async function () {
  const fixture = JSON.parse(process.env.ESKA_HOST_FIXTURE);
  const extension = vscode.extensions.all.find(value => value.packageJSON.name === 'eska-explorer');
  const explorer = await extension.activate();
  await vscode.commands.executeCommand('eska.explorer.connect');
  const connection = explorer.connection, create = connection.create;
  const entered = barrier(), proceed = barrier();
  let created = 0, completed = false;
  connection.create = options => {
    const child = create(options), request = child.request.bind(child);
    created++;
    child.request = async (...args) => {
      if (args[0] === 'workspace/open') { entered.release(); await proceed.promise; }
      return request(...args);
    };
    return child;
  };
  try {
    const starting = vscode.commands.executeCommand('eska.explorer.restart');
    await entered.promise;
    const joining = vscode.commands.executeCommand('eska.explorer.connect').then(() => { completed = true; });
    await new Promise(resolve => setTimeout(resolve, 100));
    assert.equal(completed, false, 'connect must await readiness');
    assert.equal(created, 1, 'connect must preserve the in-flight backend');
    proceed.release();
    await Promise.all([starting, joining]);
    assert.equal(connection.state.kind, 'ready');
    assert.equal(created, 1);
    const pid = connection.child.pid;
    await vscode.commands.executeCommand('eska.explorer.connect');
    assert.equal(created, 1, 'connect must reuse an already ready single-folder session');
    assert.equal(connection.child.pid, pid);
    await vscode.commands.executeCommand('eska.explorer.restart');
    assert.equal(created, 2);
    assert.notEqual(connection.child.pid, pid);
    assert.equal(connection.state.kind, 'ready');
    await fs.writeFile(path.join(fixture.root, 'host-result.json'), JSON.stringify({ passed: true, suite: 'connection-coalescing', created }));
  } finally { proceed.release(); connection.create = create; }
};
