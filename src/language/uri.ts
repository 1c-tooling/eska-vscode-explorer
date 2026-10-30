import { fileURLToPath, pathToFileURL } from "node:url";

/** Use the same Windows file URI spelling as upstream's canonical paths and document-version lookup. */
export function languageUri(value: string): string {
  if (process.platform !== "win32" || !value.startsWith("file:")) return value;
  try {
    const uri = new URL(value);
    if (uri.search || uri.hash || (!uri.hostname && !/^\/[a-z](?::|%3a)(?:\/|$)/i.test(uri.pathname))) return value;
    return pathToFileURL(fileURLToPath(uri).replace(/^[a-z]:/i, drive => drive.toUpperCase())).href;
  } catch { return value; }
}
