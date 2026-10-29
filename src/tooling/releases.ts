import { createHash } from "node:crypto";
import { isRecord } from "../protocol.js";
import { ToolFailure, analyzerAsset, assertCurrent, nativeTarget, stableVersion, type NativeTarget, type ToolKind } from "./contracts.js";
import { checksum, strictJson } from "./files.js";
import { MAX_ARCHIVE } from "./archive.js";

export interface Asset { name: string; url: string; sha256: string; size: number }
export interface ToolRelease { kind: ToolKind; version: string; target: NativeTarget; asset?: Asset; restriction?: string }
const REPOSITORIES = { project: "odineska/eska", analyzer: "itrous/bsl-analyzer", formatter: "odineska/eska" } as const;
let target: NativeTarget | undefined;

/** Resolve the extension host's runtime rather than the desktop UI's platform in Remote workspaces. */
export function hostTarget(): NativeTarget {
  if (target) return target;
  const report = process.platform === "linux" ? process.report.getReport() : undefined;
  const header = isRecord(report) && isRecord(report.header) ? report.header : undefined;
  target = nativeTarget(process.platform, process.arch, typeof header?.glibcVersionRuntime === "string");
  return target;
}

/** Bound response bytes and total elapsed time; an aborted fetch never publishes a completed download. */
export async function fetchBytes(url: string, limit: number, signal?: AbortSignal): Promise<Buffer> {
  assertCurrent(signal);
  const source = new URL(url);
  if (source.protocol !== "https:" || source.username || source.password) throw new ToolFailure("network", "https");
  const combined = AbortSignal.any([AbortSignal.timeout(limit > 4 * 1024 * 1024 ? 180_000 : 30_000), ...(signal ? [signal] : [])]);
  try {
    const response = await fetch(url, { signal: combined, headers: { "User-Agent": "eska-explorer", "Accept": "application/vnd.github+json", "X-GitHub-Api-Version": "2026-03-10" } });
    if (!response.ok || !response.body || new URL(response.url).protocol !== "https:") throw new ToolFailure("network", `http-${response.status}`);
    const declared = response.headers.get("content-length");
    if (declared && Number(declared) > limit) { await response.body.cancel(); throw new ToolFailure("network", "size"); }
    const chunks: Buffer[] = []; let size = 0;
    for await (const chunk of response.body) {
      assertCurrent(signal); size += chunk.length;
      if (size > limit) throw new ToolFailure("network", "size");
      chunks.push(Buffer.from(chunk));
    }
    assertCurrent(signal);
    return Buffer.concat(chunks);
  } catch (error) {
    assertCurrent(signal);
    throw error instanceof ToolFailure ? error : new ToolFailure("network", source.hostname, { cause: error });
  }
}

/** Only an exact named asset in the expected official release can become an installation proposal. */
export function parseRelease(kind: ToolKind, target: NativeTarget, value: unknown): ToolRelease {
  if (!isRecord(value) || value.draft !== false || value.prerelease !== false || typeof value.tag_name !== "string" || !value.tag_name.startsWith("v")
    || !Array.isArray(value.assets)) throw new ToolFailure("releaseUnavailable", "release");
  const version = stableVersion(value.tag_name.slice(1));
  const result: ToolRelease = { kind, version, target };
  const name = kind === "analyzer" ? analyzerAsset(target) : `${kind === "project" ? "eska-project" : "eska-fmt"}-${version}-${target}.zip`;
  const candidates = value.assets.filter(asset => isRecord(asset) && asset.name === name);
  if (candidates.length !== 1) return { ...result, restriction: `missing-asset:${name}` };
  const asset = candidates[0];
  if (!isRecord(asset) || !Number.isSafeInteger(asset.size) || (asset.size as number) <= 0 || (asset.size as number) > MAX_ARCHIVE
    || asset.state !== "uploaded" || typeof asset.digest !== "string" || !asset.digest.startsWith("sha256:")
    || asset.browser_download_url !== `https://github.com/${REPOSITORIES[kind]}/releases/download/v${version}/${name}`) {
    return { ...result, restriction: "asset-integrity" };
  }
  return { ...result, asset: { name, url: asset.browser_download_url as string, sha256: checksum(asset.digest.slice(7)), size: asset.size as number } };
}

/** Missing upstream project packages remain explicit; the full ESKA installer is never substituted. */
export async function latestToolRelease(kind: ToolKind, target = hostTarget(), signal?: AbortSignal): Promise<ToolRelease> {
  const data = await fetchBytes(`https://api.github.com/repos/${REPOSITORIES[kind]}/releases/latest`, 4 * 1024 * 1024, signal);
  return parseRelease(kind, target, strictJson(data));
}

/** Verify the release-provided digest and exact size before opening or executing an asset. */
export async function downloadAsset(asset: Asset, signal?: AbortSignal): Promise<Buffer> {
  const data = await fetchBytes(asset.url, Math.min(asset.size, MAX_ARCHIVE), signal);
  if (data.length !== asset.size || createHash("sha256").update(data).digest("hex") !== checksum(asset.sha256)) throw new ToolFailure("checksum", asset.name);
  return data;
}
