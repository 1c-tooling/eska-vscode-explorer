import * as vscode from "vscode";
import { dirname } from "node:path";

export const PROTECTED_SOURCE_SCHEME = "eska-protected";

/** Keep the original path while giving protected editors a provider-level readonly URI. */
export class ProtectedSources implements vscode.FileSystemProvider, vscode.Disposable {
  private readonly changes = new vscode.EventEmitter<vscode.FileChangeEvent[]>();
  readonly onDidChangeFile = this.changes.event;
  private readonly registration = vscode.workspace.registerFileSystemProvider(PROTECTED_SOURCE_SCHEME, this,
    { isReadonly: true, isCaseSensitive: process.platform !== "win32" });

  /** Preserve authority and encoded path, including Windows drives and UNC shares. */
  static protectedUri(source: vscode.Uri): vscode.Uri { return source.with({ scheme: PROTECTED_SOURCE_SCHEME }); }

  /** Resolve a protected view back to the native source for reveal and file events. */
  static sourceUri(uri: vscode.Uri): vscode.Uri {
    return uri.scheme === PROTECTED_SOURCE_SCHEME ? uri.with({ scheme: "file" }) : uri;
  }

  /** Watch the source directory and report only changes to this protected document. */
  watch(uri: vscode.Uri): vscode.Disposable {
    const source = ProtectedSources.sourceUri(uri);
    const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(vscode.Uri.file(dirname(source.fsPath)), "*"));
    const matching = (changed: vscode.Uri): boolean => {
      const left = changed.fsPath;
      const right = source.fsPath;
      return process.platform === "win32" ? left.toLowerCase() === right.toLowerCase() : left === right;
    };
    const forward = (type: vscode.FileChangeType) => (changed: vscode.Uri): void => {
      if (matching(changed)) this.changes.fire([{ type, uri }]);
    };
    const subscriptions = [watcher.onDidCreate(forward(vscode.FileChangeType.Created)),
      watcher.onDidChange(forward(vscode.FileChangeType.Changed)),
      watcher.onDidDelete(forward(vscode.FileChangeType.Deleted))];
    return new vscode.Disposable(() => {
      for (const subscription of subscriptions) subscription.dispose();
      watcher.dispose();
    });
  }

  /** Read metadata from the real file; provider capability supplies the readonly flag. */
  stat(uri: vscode.Uri): Thenable<vscode.FileStat> { return vscode.workspace.fs.stat(ProtectedSources.sourceUri(uri)); }

  /** Directory reads support normal editor lookup without exposing a writable path. */
  readDirectory(uri: vscode.Uri): Thenable<[string, vscode.FileType][]> {
    return vscode.workspace.fs.readDirectory(ProtectedSources.sourceUri(uri));
  }

  /** Return original bytes so BSL and XML offsets remain unchanged. */
  readFile(uri: vscode.Uri): Thenable<Uint8Array> { return vscode.workspace.fs.readFile(ProtectedSources.sourceUri(uri)); }

  /** Provider-level readonly also rejects direct workspace.fs mutations. */
  createDirectory(uri: vscode.Uri): void { throw vscode.FileSystemError.NoPermissions(uri); }
  writeFile(uri: vscode.Uri): void { throw vscode.FileSystemError.NoPermissions(uri); }
  delete(uri: vscode.Uri): void { throw vscode.FileSystemError.NoPermissions(uri); }
  rename(uri: vscode.Uri): void { throw vscode.FileSystemError.NoPermissions(uri); }

  /** Dispose the scheme only after the extension stops opening protected views. */
  dispose(): void { this.registration.dispose(); this.changes.dispose(); }
}
