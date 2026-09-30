import { ExplorerError, isRecord } from "./protocol.js";
import type { PropertyCaption, PropertyField } from "./properties.js";

export interface PresentedItem {
  caption: PropertyCaption;
  category?: PropertyCaption;
  detail?: PropertyCaption;
  metadataKind?: string;
  status?: "resolved" | "missing" | "unavailable";
  target?: string;
}
export type PropertyPresentation = ({ kind: "empty" } & Pick<PresentedItem, "caption">)
  | ({ kind: "reference" } & PresentedItem)
  | { kind: "types"; items: PresentedItem[] };

/** Require both locales; captions never become HTML or executable command arguments. */
function caption(value: unknown): PropertyCaption {
  if (!isRecord(value) || typeof value["ru-RU"] !== "string" || !value["ru-RU"].trim()
    || typeof value["en-US"] !== "string" || !value["en-US"].trim()) throw new ExplorerError("protocolInvalid");
  return { "ru-RU": value["ru-RU"], "en-US": value["en-US"] };
}

/** References can be actionable only when the backend supplied a resolved identity. */
function item(value: unknown, reference = false): PresentedItem {
  if (!isRecord(value)) throw new ExplorerError("protocolInvalid");
  const result: PresentedItem = { caption: caption(value.caption) };
  if (value.detail !== undefined) result.detail = caption(value.detail);
  if (value.category !== undefined) result.category = caption(value.category);
  if (reference || value.status !== undefined || value.target !== undefined || value.metadataKind !== undefined) {
    if (typeof value.metadataKind !== "string" || !value.metadataKind || !result.category
      || !["resolved", "missing", "unavailable"].includes(String(value.status))
      || (value.status === "resolved" ? typeof value.target !== "string" || !value.target : value.target !== undefined)) {
      throw new ExplorerError("protocolInvalid");
    }
    result.metadataKind = value.metadataKind;
    result.status = value.status as NonNullable<PresentedItem["status"]>;
    if (typeof value.target === "string") result.target = value.target;
  }
  return result;
}

/** Future presentation variants fall back to the unchanged raw property structure. */
export function parsePresentation(value: unknown): PropertyPresentation | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) throw new ExplorerError("protocolInvalid");
  if (value.kind === "empty") return { kind: "empty", caption: caption(value.caption) };
  if (value.kind === "reference") return { kind: "reference", ...item(value, true) };
  if (value.kind === "types") {
    if (!Array.isArray(value.items) || !value.items.length) throw new ExplorerError("protocolInvalid");
    return { kind: "types", items: value.items.map(value => item(value)) };
  }
  return undefined;
}

/** Traverse annotations once for navigation, icon selection and dependency invalidation. */
export function presentedItems(fields: readonly PropertyField[]): PresentedItem[] {
  return fields.flatMap(field => {
    const view = field.presentation;
    const own = view?.kind === "types" ? view.items : view?.kind === "reference" ? [view] : [];
    return field.value.kind === "record" ? [...own, ...presentedItems(field.value.fields)] : own;
  });
}

/** Only identities in the displayed, validated response may be opened by the webview. */
export function referenceTargets(fields: readonly PropertyField[]): Set<string> {
  return new Set(presentedItems(fields).flatMap(item => item.status === "resolved" && item.target ? [item.target] : []));
}
