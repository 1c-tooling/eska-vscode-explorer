import * as vscode from "vscode";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { compareVersions } from "../installation.js";
import { ExplorerError } from "../protocol.js";
import { message, type MessageKey } from "../messages.js";
import type { ConnectionState } from "../connection.js";
import type { DiagnosticLog } from "../diagnostics.js";
import { TOOL_NAMES, ToolFailure, assertCurrent, type ToolKind } from "./contracts.js";
import { findTool, inspectAnalyzer, inspectFormatter, type ToolInfo } from "./inspect.js";
import { installAnalyzer, installComponent, managedPath, managedVersion, recoverInstallation } from "./install.js";
import { downloadAsset, latestToolRelease, type ToolRelease } from "./releases.js";
import { cancellableChoice } from "./choice.js";
import { inspectBundle, installBundle, type BundleUpdate } from "./bundle.js";
import { runUpdateTask } from "./update-task.js";

export interface ToolState {
  info?: ToolInfo;
  phase: "missing" | "ready" | "verified" | "starting" | "checking" | "installing" | "error" | "disconnected" | "suspended" | "suspended-conflict";
  activity?: "checking" | "installing";
  available?: string;
  detail?: string;
}
const DAY = 24 * 60 * 60 * 1000;

/** Own independent setup/update state while project metadata and language lifecycles remain separate consumers. */
export class ToolingSetup implements vscode.Disposable {
  readonly root = join(homedir(), ".eska");
  readonly formatterStatus = vscode.window.createStatusBarItem("eska.explorer.formatter", vscode.StatusBarAlignment.Right, -2);
  readonly analyzerStatus = vscode.window.createStatusBarItem("eska.explorer.analyzer", vscode.StatusBarAlignment.Right, -1);
  readonly states: Record<ToolKind, ToolState> = { project: { phase: "disconnected" }, analyzer: { phase: "missing" }, formatter: { phase: "missing" } };
  private readonly checking = new Set<ToolKind>();
  private readonly installing = new Set<ToolKind>();
  private readonly pending = new Set<Promise<unknown>>();
  private readonly lifetime = new AbortController();
  private disposed = false;
  private analyzerProbe: AbortController | undefined;

  constructor(private readonly context: vscode.ExtensionContext, private readonly log: DiagnosticLog,
    private readonly repaint: () => void, private readonly stop: (kind: ToolKind) => Promise<void>,
    private readonly restart: (kind: ToolKind) => Promise<void>) {
    this.analyzerStatus.name = "BSL Analyzer (ESKA Explorer)";
    this.analyzerStatus.command = "eska.explorer.checkAnalyzerUpdates";
    this.renderAnalyzer();
    this.formatterStatus.name = "eska-fmt (ESKA Explorer)";
    this.formatterStatus.command = "eska.explorer.checkFormatterUpdates";
    this.renderFormatter();
  }

  /** Component names are stable identities; all surrounding instructions use the editor locale. */
  private text(key: MessageKey, ...values: string[]): string { return message(vscode.env.language, key, ...values); }

  /** An actual connection owns the project version; release metadata cannot replace it. */
  projectConnection(state: ConnectionState): void {
    const previous = this.states.project;
    this.states.project = state.kind === "ready"
      ? { ...previous, info: { kind: "project", path: state.target.executable, version: state.version }, phase: "ready" }
      : { ...(previous.available ? { available: previous.available } : {}), ...(previous.activity ? { activity: previous.activity } : {}), phase: state.kind === "error" ? "error" : "disconnected", detail: state.kind === "error" ? state.error.code : state.kind };
    if (!this.disposed) this.repaint();
    if (state.kind === "ready" && state.target.backend !== "legacy") void this.background("project");
  }

  /** Preserve status identity while a later language controller supplies running/suspended/error state. */
  analyzerState(phase: ToolState["phase"], detail?: string): void {
    this.states.analyzer.phase = phase;
    if (detail) this.states.analyzer.detail = detail; else delete this.states.analyzer.detail;
    this.renderAnalyzer();
  }

  /** Default discovery prefers the shared component install; explicit binaries never fall back. */
  async ensureProject(signal: AbortSignal, configured: string): Promise<string | undefined> {
    signal = AbortSignal.any([signal, this.lifetime.signal]);
    const path = await this.track(findTool(configured, TOOL_NAMES.project, dirname(managedPath(this.root, "project"))));
    assertCurrent(signal);
    if (path) return path;
    if (configured !== TOOL_NAMES.project) throw new ExplorerError("executableMissing");
    const installed = await this.offerInstall("project", signal);
    return installed?.path;
  }

  /** Inspect language binaries independently; missing analysis never prevents a metadata connection. */
  async ensureAnalyzer(signal = this.lifetime.signal, offer = true): Promise<ToolInfo | undefined> {
    this.analyzerProbe?.abort();
    this.analyzerProbe = new AbortController();
    signal = AbortSignal.any([signal, this.lifetime.signal, this.analyzerProbe.signal]);
    if (!vscode.workspace.isTrusted || this.disposed) return undefined;
    const configured = vscode.workspace.getConfiguration("eska.explorer").get<string>("analyzerExecutable", TOOL_NAMES.analyzer);
    const path = await this.track(findTool(configured, TOOL_NAMES.analyzer, dirname(managedPath(this.root, "analyzer"))));
    assertCurrent(signal);
    if (!path) {
      delete this.states.analyzer.info;
      if (!this.states.analyzer.phase.startsWith("suspended")) this.states.analyzer = { phase: "missing" };
      this.renderAnalyzer();
      if (offer && configured === TOOL_NAMES.analyzer) return this.offerInstall("analyzer", signal);
      if (offer) throw new ExplorerError("executableMissing");
      return undefined;
    }
    try {
      const info = await this.track(inspectAnalyzer(path, homedir(), signal));
      assertCurrent(signal);
      this.states.analyzer = { ...this.states.analyzer, info, phase: this.states.analyzer.phase.startsWith("suspended") ? this.states.analyzer.phase : "verified" }; this.renderAnalyzer();
      void this.background("analyzer");
      return info;
    } catch (error) {
      if (!signal.aborted && !this.disposed) {
        delete this.states.analyzer.info;
        if (!this.states.analyzer.phase.startsWith("suspended")) this.states.analyzer = { phase: "error" };
        this.renderAnalyzer();
      }
      throw error;
    }
  }

  /** Formatter discovery has its own contract, installation and status; no analyzer is queried or started. */
  async ensureFormatter(signal = this.lifetime.signal, offer = true,
    configured = vscode.workspace.getConfiguration("eska.explorer").get<string>("formatterExecutable", TOOL_NAMES.formatter)): Promise<ToolInfo | undefined> {
    signal = AbortSignal.any([signal, this.lifetime.signal]);
    if (!vscode.workspace.isTrusted || this.disposed) return undefined;
    if (configured !== TOOL_NAMES.formatter && !isAbsolute(configured)) throw new ExplorerError("invalidExecutable");
    const path = await this.track(findTool(configured, TOOL_NAMES.formatter, dirname(managedPath(this.root, "formatter"))));
    assertCurrent(signal);
    if (!path) {
      this.states.formatter = { phase: "missing" }; this.renderFormatter();
      if (offer && configured === TOOL_NAMES.formatter) return this.offerInstall("formatter", signal);
      if (offer) throw new ExplorerError("executableMissing");
      return undefined;
    }
    try {
      const info = await this.track(inspectFormatter(path, homedir(), signal));
      assertCurrent(signal);
      this.states.formatter = { ...this.states.formatter, info, phase: "verified" }; this.renderFormatter();
      void this.background("formatter"); return info;
    } catch (error) {
      if (!signal.aborted && !this.disposed) { this.states.formatter = { phase: "error" }; this.renderFormatter(); }
      throw error;
    }
  }

  /** One explicit preparation command exposes both selected versions before installing missing components. */
  async prepare(configured: string, signal: AbortSignal): Promise<void> {
    if (!vscode.workspace.isTrusted || this.disposed) return;
    const project = await this.ensureProject(signal, configured);
    assertCurrent(signal);
    if (project) { await this.ensureFormatter(signal); await this.ensureAnalyzer(signal); }
  }

  /** Background timestamps and in-flight flags belong to each component on this workspace host. */
  async background(kind: ToolKind): Promise<void> {
    const setting = kind === "project" ? "checkForUpdates" : kind === "analyzer" ? "checkForAnalyzerUpdates" : "checkForFormatterUpdates";
    if (this.disposed || this.checking.has(kind) || this.installing.has(kind)
      || !vscode.workspace.getConfiguration("eska.explorer").get<boolean>(setting, true)) return;
    const key = `toolUpdateChecked.${kind}.${vscode.env.remoteName ?? "local"}.${process.platform}.${process.arch}`;
    if (Date.now() - this.context.globalState.get<number>(key, 0) < DAY) return;
    // Claim the daily slot synchronously before awaiting persistent storage or the network.
    this.checking.add(kind);
    try { await this.context.globalState.update(key, Date.now()); await this.check(kind, false, true); }
    finally { this.checking.delete(kind); }
  }

  /** Manual checks ignore the daily interval; neither component shares a busy flag with its peer. */
  async check(kind: ToolKind, manual = true, claimed = false): Promise<void> {
    if (this.disposed || !vscode.workspace.isTrusted || this.installing.has(kind) || (!claimed && this.checking.has(kind))) return;
    this.checking.add(kind);
    const state = this.states[kind];
    const controller = new AbortController(), signal = AbortSignal.any([controller.signal, this.lifetime.signal]);
    state.activity = "checking"; this.render(kind);
    try {
      const load = async (): Promise<{ bundle: BundleUpdate } | { release: ToolRelease; installed: string | undefined }> => {
        const installed = await managedVersion(this.root, kind);
        assertCurrent(signal);
        const bundle = kind === "project" && !installed ? await inspectBundle(this.root, signal) : undefined;
        if (bundle) return { bundle };
        return { release: await latestToolRelease(kind, undefined, signal), installed };
      };
      const result = await this.track(manual
        ? vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, cancellable: true, title: this.text("toolChecking", TOOL_NAMES[kind]) }, async (_progress, token) => {
          const subscription = token.onCancellationRequested(() => controller.abort());
          try { if (token.isCancellationRequested) controller.abort(); return await load(); }
          finally { subscription.dispose(); }
        }) : load());
      assertCurrent(signal);
      if ("bundle" in result) {
        const update = result.bundle;
        state.available = update.available;
        if (compareVersions(update.available, update.version) <= 0) {
          if (manual) void vscode.window.showInformationMessage(this.text("toolCurrent", "ESKA", update.version));
          return;
        }
        const choice = await cancellableChoice(vscode.window.showInformationMessage(this.text("toolBundleUpdateOffer", update.version, update.available,
          update.cli, state.info ? `${state.info.version} · ${state.info.path}` : this.text("toolMissing")), this.text("toolInstall")), signal);
        if (choice && !this.disposed && !signal.aborted) await this.performBundle(update);
        return;
      }
      const { release, installed } = result;
      state.available = release.version;
      if (installed && compareVersions(release.version, installed) <= 0) {
        if (manual) void vscode.window.showInformationMessage(this.text("toolCurrent", TOOL_NAMES[kind], installed));
        return;
      }
      if (release.restriction || !release.asset) {
        if (manual || installed) void vscode.window.showWarningMessage(this.text("toolReleaseRestricted", TOOL_NAMES[kind], release.version, this.restriction(release)));
        return;
      }
      const choice = await vscode.window.showInformationMessage(this.text("toolUpdateOffer", TOOL_NAMES[kind], installed ?? this.text("toolMissing"), release.version,
        state.info ? `${state.info.version} · ${state.info.path}` : this.text("toolMissing")), this.text("toolInstall"));
      if (!choice || this.disposed) return;
      await this.perform(release, this.lifetime.signal);
    } catch (error) { if (manual && !this.disposed && !signal.aborted) this.report(error); }
    finally {
      delete this.states[kind].activity;
      this.checking.delete(kind); this.render(kind);
    }
  }

  /** A cargo-dist bundle owns all ESKA commands; only its selected project session is restarted. */
  private async performBundle(update: BundleUpdate): Promise<void> {
    if (this.installing.has("project")) throw new ToolFailure("busy", "project");
    this.installing.add("project");
    this.states.project.activity = "installing"; this.render("project");
    const selected = this.states.project.info?.path;
    const used = !selected || resolve(selected) === resolve(update.project);
    let reconnect = false;
    try {
      const info = await this.track(vscode.window.withProgress({ location: vscode.ProgressLocation.Notification,
        title: this.text("toolInstalling", "ESKA", update.available) }, async () => {
        if (used && selected) { await this.stop("project"); reconnect = true; }
        return installBundle(this.root, update, (cli, args) => {
          this.log(JSON.stringify({ event: "bundle_update_start", executable: cli, args }));
          return runUpdateTask(cli, args, this.text("toolInstalling", "ESKA", update.available), this.lifetime.signal);
        }, this.log, this.lifetime.signal);
      }));
      if (used) { this.states.project = { info, phase: "disconnected" }; reconnect = true; }
      this.log(JSON.stringify({ event: "bundle_update_completed", path: info.path, version: info.version }));
      if (!this.disposed) void vscode.window.showInformationMessage(this.text("toolInstalled", "ESKA", info.version));
    } finally {
      try { if (reconnect && !this.disposed) await this.restart("project"); }
      finally { this.installing.delete("project"); delete this.states.project.activity; this.render("project"); }
    }
  }

  /** The proposal names the pair; each approved installation still changes only its selected component. */
  private async offerInstall(kind: ToolKind, signal: AbortSignal): Promise<ToolInfo | undefined> {
    const release = await this.track(latestToolRelease(kind, undefined, signal));
    assertCurrent(signal);
    if (release.restriction || !release.asset) {
      void vscode.window.showWarningMessage(this.text("toolReleaseRestricted", TOOL_NAMES[kind], release.version, this.restriction(release)));
      return undefined;
    }
    const other = this.states[kind === "project" ? "analyzer" : "project"].info;
    const choice = await cancellableChoice(vscode.window.showWarningMessage(this.text("toolInstallOffer", TOOL_NAMES[kind], release.version,
      other ? `${TOOL_NAMES[other.kind]} v${other.version}` : this.text("toolMissing")), this.text("toolInstall")), signal);
    if (!choice || signal.aborted || this.disposed) return undefined;
    return this.perform(release, signal, false);
  }

  /** Download before stopping the selected service, then verify the staged and installed executable. */
  private async perform(release: ToolRelease, signal: AbortSignal, reconnect = true): Promise<ToolInfo> {
    const kind = release.kind;
    if (this.installing.has(kind) || !release.asset) throw new ToolFailure("busy", kind);
    this.installing.add(kind);
    const state = this.states[kind], prior = state.phase;
    state.activity = "installing"; this.render(kind);
    const selected = state.info?.path, path = managedPath(this.root, kind, release.target);
    const used = !selected || (process.platform === "win32" ? resolve(selected).toLowerCase() === resolve(path).toLowerCase() : selected === path);
    let stopped = false;
    try {
      return await this.track(vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, cancellable: true, title: this.text("toolInstalling", TOOL_NAMES[kind], release.version) }, async (_progress, token) => {
        const cancelled = new AbortController(), subscription = token.onCancellationRequested(() => cancelled.abort());
        const combined = AbortSignal.any([signal, this.lifetime.signal, cancelled.signal]);
        try {
          if (token.isCancellationRequested) cancelled.abort();
          const data = await downloadAsset(release.asset!, combined);
          assertCurrent(combined);
          if (used && selected) { await this.stop(kind); stopped = true; }
          assertCurrent(combined);
          const info = kind !== "analyzer" ? await installComponent(this.root, data, release, this.log, combined)
            : await installAnalyzer(this.root, data, release, join(this.context.extensionPath, "resources", "analyzer-notices"), combined);
          assertCurrent(combined);
          if (used) {
            const current = this.states[kind];
            this.states[kind] = { info, phase: kind === "project" ? "disconnected" : current.phase.startsWith("suspended") ? current.phase : prior === "suspended" ? "suspended" : "verified",
              ...(kind === "analyzer" && current.phase.startsWith("suspended") && current.detail ? { detail: current.detail } : {}) };
            if (reconnect) await this.restart(kind);
          }
          void vscode.window.showInformationMessage(this.text("toolInstalled", TOOL_NAMES[kind], info.version));
          return info;
        } finally { subscription.dispose(); }
      }));
    } catch (error) {
      if (stopped && !this.lifetime.signal.aborted) await this.restart(kind);
      throw error;
    } finally {
      this.installing.delete(kind);
      delete this.states[kind].activity;
      this.render(kind);
    }
  }

  /** Explain release restrictions in both locales while preserving exact asset names as identifiers. */
  private restriction(release: ToolRelease): string {
    const reason = release.restriction ?? "asset-integrity";
    if (reason.startsWith("missing-asset:")) return this.text("toolMissingAsset", reason.slice("missing-asset:".length));
    if (reason.startsWith("supported-analyzer-")) return this.text("toolSupportedAnalyzer", reason.slice("supported-analyzer-".length));
    return this.text("toolAssetIntegrity");
  }

  /** Explicit recovery uses the same verified journal as the CLI; user-modified files remain blocked. */
  async recover(kind: ToolKind): Promise<void> {
    if (!vscode.workspace.isTrusted || this.installing.has(kind) || this.disposed) return;
    try { await this.track(recoverInstallation(this.root, kind)); void vscode.window.showInformationMessage(this.text("toolRecovered", TOOL_NAMES[kind])); }
    catch (error) { this.report(error); }
  }

  /** Keep technical details in logs and a concise translated action in notifications. */
  report(error: unknown): void {
    const code = error instanceof ToolFailure ? error.code : error instanceof ExplorerError ? error.code : "io";
    const detail = error instanceof ToolFailure ? error.detail : "";
    this.log(JSON.stringify({ event: "tool_setup_failed", code, detail }), "error");
    if (!this.disposed && code !== "cancelled") void vscode.window.showErrorMessage(this.text("toolFailed", code, detail));
  }

  /** Tooltip always distinguishes the selected executable from the separately managed installation. */
  tooltip(kind: ToolKind): string {
    const state = this.states[kind];
    return this.text("toolTooltip", TOOL_NAMES[kind], state.info?.version ?? this.text("toolMissing"), state.info?.path ?? "—",
      this.text(`toolPhase_${state.phase}`), managedPath(this.root, kind), state.available ?? "—")
      + (state.activity ? `\n${this.text(`toolPhase_${state.activity}`)}` : "") + (state.detail ? `\n${state.detail}` : "");
  }

  /** Update activity never replaces the installed version with the offered release number. */
  private renderAnalyzer(): void {
    if (this.disposed) return;
    const state = this.states.analyzer;
    this.analyzerStatus.text = `BSL Analyzer${state.info ? ` v${state.info.version}` : ""}${state.phase === "ready" ? "" : ` · ${this.text(`toolPhase_${state.phase}`)}`}${state.activity ? ` · ${this.text(`toolPhase_${state.activity}`)}` : ""}`;
    this.analyzerStatus.tooltip = this.tooltip("analyzer");
    this.analyzerStatus.show();
  }

  /** Optional formatting remains visible independently of project connection and language readiness. */
  private renderFormatter(): void {
    if (this.disposed) return;
    const state = this.states.formatter;
    this.formatterStatus.text = `eska-fmt${state.info ? ` v${state.info.version}` : ""} · ${this.text(`toolPhase_${state.phase}`)}${state.activity ? ` · ${this.text(`toolPhase_${state.activity}`)}` : ""}`;
    this.formatterStatus.tooltip = this.tooltip("formatter"); this.formatterStatus.show();
  }

  /** Project rendering stays with its actual metadata connection; analysis has its own status item. */
  private render(kind: ToolKind): void { if (!this.disposed) { if (kind === "analyzer") this.renderAnalyzer(); else if (kind === "formatter") this.renderFormatter(); else this.repaint(); } }

  /** Track only owned work, so an open user dialog cannot prevent extension shutdown. */
  private track<T>(operation: PromiseLike<T>): Promise<T> {
    const result = Promise.resolve(operation);
    this.pending.add(result);
    void result.finally(() => this.pending.delete(result)).catch(() => {});
    return result;
  }

  /** Reap probes, abort downloads and finish rollback before unloading runtime dependencies. */
  async shutdown(): Promise<void> { this.dispose(); while (this.pending.size) await Promise.allSettled([...this.pending]); }

  /** Disposal never terminates a user or foreign analyzer process. */
  dispose(): void { if (!this.disposed) { this.disposed = true; this.lifetime.abort(); this.analyzerStatus.dispose(); this.formatterStatus.dispose(); } }
}
