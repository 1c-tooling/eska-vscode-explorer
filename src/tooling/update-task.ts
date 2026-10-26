import * as vscode from "vscode";
import { homedir } from "node:os";
import { ExplorerError } from "../protocol.js";
import { assertCurrent } from "./contracts.js";

/** Let the editor own the installer process tree and await the exact task, including early completion. */
export async function runUpdateTask(cli: string, args: string[], title: string, signal: AbortSignal): Promise<void> {
  assertCurrent(signal);
  const task = new vscode.Task({ type: "eska-bundle-update" }, vscode.TaskScope.Global, title, "ESKA",
    new vscode.ProcessExecution(cli, args, { cwd: homedir() }));
  task.presentationOptions = { reveal: vscode.TaskRevealKind.Always, panel: vscode.TaskPanelKind.Dedicated };
  await new Promise<void>((resolve, reject) => {
    let execution: vscode.TaskExecution | undefined;
    const early = new Map<vscode.TaskExecution, number | undefined>();
    const abort = (): void => { execution?.terminate(); };
    const clean = (): void => { processSubscription.dispose(); endSubscription.dispose(); signal.removeEventListener("abort", abort); };
    const finish = (ended: vscode.TaskExecution, code: number | undefined): void => {
      if (!execution) { early.set(ended, code); return; }
      if (ended !== execution) return;
      clean();
      if (signal.aborted) reject(new ExplorerError("cancelled"));
      else if (code !== 0) reject(new ExplorerError("updateFailed"));
      else resolve();
    };
    const processSubscription = vscode.tasks.onDidEndTaskProcess(event => finish(event.execution, event.exitCode));
    const endSubscription = vscode.tasks.onDidEndTask(event => { if (!early.has(event.execution)) finish(event.execution, undefined); });
    signal.addEventListener("abort", abort, { once: true });
    void vscode.tasks.executeTask(task).then(started => {
      execution = started;
      if (signal.aborted) abort();
      if (early.has(started)) finish(started, early.get(started));
    }, error => { clean(); reject(error); });
  });
}
