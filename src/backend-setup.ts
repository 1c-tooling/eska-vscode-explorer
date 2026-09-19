import * as vscode from "vscode";
import { mkdir, open, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { join, dirname, delimiter } from "node:path";
import { bootstrapCommand, checkUpdate, compareVersions, inspectGlobal, latestRelease, type GlobalCli, type InstallCommand } from "./installation.js";
import { ExplorerError } from "./protocol.js";
import { message, type MessageKey } from "./messages.js";
import type { DiagnosticLog } from "./diagnostics.js";

/** Coordinate user-owned global installation; downloads and process replacement require an explicit UI action. */
export class BackendSetup implements vscode.Disposable {
  private disposed = false;
  private busy = false;
  private checking = false;
  private execution: vscode.TaskExecution | undefined;
  private readonly lifetime = new AbortController();
  private readonly pending = new Set<Promise<unknown>>();

  constructor(private readonly context: vscode.ExtensionContext, private readonly log: DiagnosticLog,
    private readonly disconnect: () => Promise<void>, private readonly reconnect: () => Promise<void>) {}

  /** Keep installation messages in the editor language rather than the metadata tree language. */
  private text(key: MessageKey, ...values: string[]): string { return message(vscode.env.language, key, ...values); }

  /** A development override never removes the requirement for a compatible global CLI. */
  async ensure(signal = this.lifetime.signal): Promise<string | undefined> {
    signal = AbortSignal.any([signal, this.lifetime.signal]);
    if (this.busy || this.disposed) return undefined;
    const cli = await this.track(inspectGlobal(this.log, signal));
    if (signal.aborted) return undefined;
    if (cli?.compatible) { return cli.path; }
    const release = await this.track(latestRelease(signal));
    const choice = await vscode.window.showWarningMessage(this.text(cli ? "cliIncompatible" : "cliMissing", cli?.version ?? "", release.version), this.text("cliInstall"));
    if (!choice || signal.aborted) return undefined;
    if (cli && compareVersions(release.version, cli.version) <= 0) throw new ExplorerError("incompatible");
    const command = await this.track(bootstrapCommand(cli, release, signal));
    const installed = await this.track(this.perform(command));
    if (signal.aborted) return undefined;
    if (!installed?.compatible) throw new ExplorerError("cliPathConflict");
    return installed.path;
  }

  /** Check at most daily in the background; lack of network never prevents a working tree. */
  async background(): Promise<void> {
    if (!vscode.workspace.getConfiguration("eska.explorer").get<boolean>("checkForUpdates", true) || this.checking || this.disposed) return;
    const last = this.context.globalState.get<number>("cliUpdateChecked", 0);
    if (Date.now() - last < 24 * 60 * 60 * 1000) return;
    await this.context.globalState.update("cliUpdateChecked", Date.now());
    await this.check(false);
  }

  /** One update command uses the same global CLI regardless of a custom development backend. */
  async check(manual: boolean): Promise<void> {
    if (this.checking || this.busy || this.disposed || !vscode.workspace.isTrusted) return;
    this.checking = true;
    let approved = false;
    try {
      const cli = await this.track(inspectGlobal(this.log, this.lifetime.signal));
      if (this.disposed) return;
      if (!cli) { if (manual && await this.ensure()) await this.reconnect(); return; }
      const release = cli.selfUpdate ? undefined : await this.track(latestRelease(this.lifetime.signal));
      const available = release ? release.version : (await this.track(checkUpdate(cli, this.lifetime.signal))).version;
      if (this.disposed) return;
      if (!available || compareVersions(available, cli.version) <= 0) {
        if (manual) void vscode.window.showInformationMessage(this.text("cliCurrent", cli.version));
        return;
      }
      const choice = await vscode.window.showInformationMessage(this.text("cliUpdateAvailable", cli.version, available), this.text("cliUpdate"));
      if (!choice || this.disposed) return;
      approved = true;
      const command: InstallCommand = !release
        ? { executable: cli.path, args: ["update", "--target-version", available, "--format", "json"], cwd: homedir(), async dispose() {} }
        : await this.track(bootstrapCommand(cli, release, this.lifetime.signal));
      const installed = await this.track(this.perform(command));
      if (this.disposed) return;
      if (!installed?.compatible || compareVersions(installed.version, available) < 0) throw new ExplorerError("cliPathConflict");
      await this.reconnect();
      void vscode.window.showInformationMessage(this.text("cliUpdated", installed.version));
    } catch (error) {
      this.log(JSON.stringify({ event: "cli_update_failed", code: error instanceof ExplorerError ? error.code : "updateFailed" }), "error");
      if ((manual || approved) && !this.disposed) void vscode.window.showErrorMessage(this.text(error instanceof ExplorerError ? error.code : "updateFailed"));
    } finally { this.checking = false; }
  }

  /** Tasks keep long Cargo compilations visible and let VS Code manage their child processes. */
  private async perform(command: InstallCommand): Promise<GlobalCli | undefined> {
    if (this.busy || this.disposed) { await command.dispose(); throw new ExplorerError("updateBusy"); }
    this.busy = true;
    let locked = false;
    const root = join(homedir(), ".eska");
    const lock = join(root, ".explorer-install.lock");
    try {
      await mkdir(root, { recursive: true });
      const file = await open(lock, "wx").catch(() => { throw new ExplorerError("updateBusy"); });
      locked = true;
      await file.close();
      await this.disconnect();
      if (this.disposed) throw new ExplorerError("cancelled");
      this.log(JSON.stringify({ event: "cli_install_start", executable: command.executable, args: command.args }));
      await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: this.text("cliInstalling") }, async () => {
        const task = new vscode.Task({ type: "eska-cli-update" }, vscode.TaskScope.Global, this.text("cliInstalling"), "ESKA",
          new vscode.ProcessExecution(command.executable, command.args, { cwd: command.cwd, ...(command.env ? { env: command.env } : {}) }));
        task.presentationOptions = { reveal: vscode.TaskRevealKind.Always, panel: vscode.TaskPanelKind.Dedicated };
        const completed = new Promise<number | undefined>((resolve, reject) => {
          const early = new Map<vscode.TaskExecution, number | undefined>();
          let processSubscription: vscode.Disposable;
          let endSubscription: vscode.Disposable;
          const finish = (execution: vscode.TaskExecution, code: number | undefined): void => {
            if (!this.execution) { early.set(execution, code); return; }
            if (execution !== this.execution) return;
            processSubscription.dispose(); endSubscription.dispose();
            this.execution = undefined; resolve(code);
          };
          processSubscription = vscode.tasks.onDidEndTaskProcess(event => finish(event.execution, event.exitCode));
          endSubscription = vscode.tasks.onDidEndTask(event => {
            if (!early.has(event.execution)) finish(event.execution, undefined);
          });
          void vscode.tasks.executeTask(task).then(execution => {
            this.execution = execution;
            if (this.disposed) execution.terminate();
            if (early.has(execution)) finish(execution, early.get(execution));
          }, error => { processSubscription.dispose(); endSubscription.dispose(); reject(error); });
        });
        if (await completed !== 0) throw new ExplorerError("updateFailed");
      });
      // New integrated terminals receive the installed user command without restarting the extension host.
      const installed = await this.track(inspectGlobal(this.log, this.lifetime.signal));
      if (this.disposed) return;
      if (installed?.compatible) this.context.environmentVariableCollection.prepend("PATH", `${dirname(installed.path)}${delimiter}`);
      this.log(JSON.stringify({ event: "cli_install_completed", path: installed?.path, version: installed?.version }));
      return installed;
    } finally {
      try { await command.dispose(); }
      finally {
        try { if (locked) await rm(lock, { force: true }); }
        finally { this.busy = false; }
      }
    }
  }

  /** Track owned IO and tasks, excluding user dialogs that may remain open during shutdown. */
  private track<T>(operation: Promise<T>): Promise<T> {
    this.pending.add(operation);
    void operation.finally(() => this.pending.delete(operation)).catch(() => {});
    return operation;
  }

  /** Deactivation waits for probe reaping, task completion and the installation lock cleanup. */
  async shutdown(): Promise<void> {
    this.dispose();
    while (this.pending.size) await Promise.allSettled([...this.pending]);
  }

  /** Stop only this extension's probes, downloads and installation task. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.lifetime.abort();
    this.execution?.terminate();
  }
}
