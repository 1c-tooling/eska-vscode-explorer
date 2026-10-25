import * as vscode from "vscode";
import { dirname } from "node:path";
import { ExplorerError } from "./protocol.js";
import { message } from "./messages.js";
import type { SourceView } from "./source-access.js";

export const PROTECTED_SOURCE_SCHEME = "eska-protected";
type ReadSource = { header: SourceView; bytes: Uint8Array };
interface Observation { uri: vscode.Uri; watchers: number; snapshot?: string; mtime: number }

/** Keep the original path while giving protected editors a provider-level readonly URI. */
export class ProtectedSources implements vscode.FileSystemProvider, vscode.Disposable {
  private readonly changes = new vscode.EventEmitter<vscode.FileChangeEvent[]>();
  private readonly observed = new Map<string, Observation>();
  private readonly pending = new Map<string, Promise<ReadSource>>();
  private serial: Promise<void> = Promise.resolve();
  private disposed = false;
  readonly onDidChangeFile = this.changes.event;
  private readonly registration = vscode.workspace.registerFileSystemProvider(PROTECTED_SOURCE_SCHEME, this,
    { isReadonly: new vscode.MarkdownString(message(vscode.env.language, "protectedSourceReadonly")), isCaseSensitive: process.platform !== "win32" });
  private readonly nativeChanges = vscode.workspace.onDidChangeTextDocument(event => {
    if (event.document.uri.scheme === "file") this.refresh(event.document.uri);
  });
  private readonly nativeTabs = vscode.window.tabGroups.onDidChangeTabs(event => {
    for (const tab of [...event.opened, ...event.changed, ...event.closed]) {
      if (tab.input instanceof vscode.TabInputText && tab.input.uri.scheme === "file") this.refresh(tab.input.uri);
    }
  });

  constructor(private readonly read: (source: vscode.Uri) => Promise<ReadSource>, private readonly failed: (error: unknown) => void) {}

  /** Preserve authority and encoded path, including Windows drives and UNC shares. */
  static protectedUri(source: vscode.Uri): vscode.Uri { return source.with({ scheme: PROTECTED_SOURCE_SCHEME }); }

  /** Resolve a protected view back to the native source for reveal and file events. */
  static sourceUri(uri: vscode.Uri): vscode.Uri {
    return uri.scheme === PROTECTED_SOURCE_SCHEME ? uri.with({ scheme: "file" }) : uri;
  }

  /** Watch the source directory and report only changes to this protected document. */
  watch(uri: vscode.Uri): vscode.Disposable {
    const key = uri.toString();
    const observed = this.observed.get(key) ?? { uri, watchers: 0, mtime: 0 };
    observed.watchers++; this.observed.set(key, observed);
    const source = ProtectedSources.sourceUri(uri);
    const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(vscode.Uri.file(dirname(source.fsPath)), "*"));
    const matching = (changed: vscode.Uri): boolean => {
      if (changed.scheme !== source.scheme) return false;
      const left = changed.fsPath;
      const right = source.fsPath;
      return process.platform === "win32" ? left.toLowerCase() === right.toLowerCase() : left === right;
    };
    const forward = (changed: vscode.Uri): void => {
      if (matching(changed)) this.refresh(source);
    };
    const subscriptions = [watcher.onDidCreate(forward), watcher.onDidChange(forward), watcher.onDidDelete(forward)];
    return new vscode.Disposable(() => {
      if (--observed.watchers === 0) this.observed.delete(key);
      for (const subscription of subscriptions) subscription.dispose();
      watcher.dispose();
    });
  }

  /** Native directory metadata is presentation; file size and freshness describe the exact backend-selected bytes. */
  async stat(uri: vscode.Uri): Promise<vscode.FileStat> {
    let physical: vscode.FileStat | undefined;
    try { physical = await vscode.workspace.fs.stat(ProtectedSources.sourceUri(uri)); }
    catch { /* A retained dirty owner can outlive its physical source; ESKA decides whether it is inspectable. */ }
    if (physical && (physical.type & vscode.FileType.Directory)) return physical;
    const view = await this.capture(uri);
    return { type: vscode.FileType.File, ctime: physical?.ctime ?? 0, mtime: this.observed.get(uri.toString())?.mtime ?? Date.now(),
      size: view.bytes.byteLength, permissions: vscode.FilePermission.Readonly };
  }

  /** Directory reads support normal editor lookup without exposing a writable path. */
  readDirectory(uri: vscode.Uri): Thenable<[string, vscode.FileType][]> {
    return vscode.workspace.fs.readDirectory(ProtectedSources.sourceUri(uri));
  }

  /** ESKA supplies source content; this URI adapter never chooses a disk or native owner snapshot itself. */
  async readFile(uri: vscode.Uri): Promise<Uint8Array> { return (await this.capture(uri)).bytes; }

  /** Workspace, source ownership and native-buffer events invalidate pending presentation without retaining body caches. */
  refresh(source?: vscode.Uri): void {
    if (this.disposed) return;
    const selected = [...this.observed.values()].filter(value => !source || ProtectedSources.sourceUri(value.uri).toString() === source.toString());
    for (const value of selected) this.pending.delete(value.uri.toString());
    if (selected.length) this.changes.fire(selected.map(value => ({ type: vscode.FileChangeType.Changed, uri: value.uri })));
  }

  /** Coalesce stat/read while queued and bound concurrent backend view handles to one provider read. */
  private capture(uri: vscode.Uri): Promise<ReadSource> {
    const key = uri.toString(), pending = this.pending.get(key);
    if (pending) return pending;
    const request = this.serial.then(async () => {
      try {
        if (this.disposed) throw new ExplorerError("obsolete");
        const view = await this.read(ProtectedSources.sourceUri(uri));
        const observed = this.observed.get(key);
        if (observed && observed.snapshot !== view.header.snapshot) {
          observed.snapshot = view.header.snapshot;
          observed.mtime = Math.max(Date.now(), observed.mtime + 1);
        }
        return view;
      } catch (error) {
        this.failed(error);
        throw vscode.FileSystemError.Unavailable(message(vscode.env.language,
          error instanceof ExplorerError && error.code === "incompatible" ? "protectedSourceBackend" : "protectedSourceUnavailable"));
      }
    });
    this.serial = request.then(() => {}, () => {});
    this.pending.set(key, request);
    void request.finally(() => { if (this.pending.get(key) === request) this.pending.delete(key); }).catch(() => {});
    return request;
  }

  /** Provider-level readonly also rejects direct workspace.fs mutations. */
  createDirectory(uri: vscode.Uri): void { throw vscode.FileSystemError.NoPermissions(uri); }
  writeFile(uri: vscode.Uri): void { throw vscode.FileSystemError.NoPermissions(uri); }
  delete(uri: vscode.Uri): void { throw vscode.FileSystemError.NoPermissions(uri); }
  rename(uri: vscode.Uri): void { throw vscode.FileSystemError.NoPermissions(uri); }

  /** Dispose the scheme only after the extension stops opening protected views. */
  dispose(): void { this.disposed = true; this.nativeChanges.dispose(); this.nativeTabs.dispose(); this.registration.dispose(); this.changes.dispose(); this.observed.clear(); this.pending.clear(); }
}
