import { isRecord } from "./protocol.js";

export type PicturePreview = { status: "ready"; mimeType: string; data: string; fileName: string }
  | { status: "missing" | "unsupported" | "invalid" | "too_large" | "unavailable" };

const mimeTypes = new Set(["image/png", "image/jpeg", "image/gif", "image/bmp", "image/x-icon", "image/webp", "image/svg+xml"]);

/** Only bounded image data may cross into an img element; older backends omit this field. */
export function picturePreview(value: unknown): PicturePreview | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) return { status: "invalid" };
  if (value.status === "ready") {
    if (typeof value.mimeType !== "string" || !mimeTypes.has(value.mimeType)
      || typeof value.data !== "string" || value.data.length > 11_184_812 || value.data.length === 0
      || value.data.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value.data)
      || typeof value.fileName !== "string") return { status: "invalid" };
    return { status: "ready", mimeType: value.mimeType, data: value.data, fileName: value.fileName };
  }
  switch (value.status) {
    case "missing": case "unsupported": case "invalid": case "too_large": case "unavailable":
      return { status: value.status };
    default: return { status: "invalid" };
  }
}
