import { ExplorerError } from "./protocol.js";

/** Remote file URIs are native only when this workspace extension runs on the remote host. */
export function assertHost(trusted: boolean, scheme: string, remoteName: string | undefined): void {
  if (!trusted) throw new ExplorerError("untrusted");
  if (scheme !== "file" && !(scheme === "vscode-remote" && remoteName)) {
    throw new ExplorerError("unsupportedWorkspace");
  }
}
