import { ExplorerError, isRecord } from "./protocol.js";

export interface RenameTransition { from: string; to: string; descendantFrom: string; descendantTo: string }

/** ID remapping is supplied by the server; clients never derive metadata addresses from names. */
export function renameTransition(value: unknown): RenameTransition {
  if (!isRecord(value) || ["from", "to", "descendantFrom", "descendantTo"].some(key => typeof value[key] !== "string" || !value[key])) {
    throw new ExplorerError("protocolInvalid");
  }
  return value as unknown as RenameTransition;
}

/** Apply only the exact identity and descendant prefix explicitly authorized by the backend. */
export function renamedIdentity(id: string, change: RenameTransition): string {
  return id === change.from ? change.to : id.startsWith(change.descendantFrom)
    ? change.descendantTo + id.slice(change.descendantFrom.length) : id;
}

export interface RenameOccurrence { range: { start: number; end: number }; before?: string; after?: string; text?: string; reason?: string }
export interface RenameFile { path: string; snapshot: string; replacements: RenameOccurrence[]; uncertain: RenameOccurrence[] }
export interface RenamePlan {
  objectId: string; newObjectId: string; oldName: string; newName: string; snapshot: string;
  files: RenameFile[]; moves: { from: string; to: string; directory: boolean }[]; issues: { path: string; reason: string }[];
}

/** Reject malformed previews before they supply navigation ranges or a publication token. */
export function renamePlan(value: unknown): RenamePlan {
  const plan = isRecord(value) ? value.plan : undefined;
  const range = (item: unknown): item is Record<string, unknown> => isRecord(item) && isRecord(item.range)
    && Number.isSafeInteger(item.range.start) && Number.isSafeInteger(item.range.end)
    && Number(item.range.start) >= 0 && Number(item.range.end) >= Number(item.range.start);
  if (!isRecord(plan) || !["objectId", "newObjectId", "oldName", "newName"].every(key => typeof plan[key] === "string" && plan[key])
    || typeof plan.snapshot !== "string" || !/^[a-f0-9]{64}$/.test(plan.snapshot)
    || !Array.isArray(plan.files) || !plan.files.every(file => isRecord(file) && typeof file.path === "string"
      && typeof file.snapshot === "string" && /^[a-f0-9]{64}$/.test(file.snapshot)
      && Array.isArray(file.replacements) && file.replacements.every(item => range(item) && typeof item.before === "string" && typeof item.after === "string")
      && Array.isArray(file.uncertain) && file.uncertain.every(item => range(item) && typeof item.text === "string" && typeof item.reason === "string"))
    || !Array.isArray(plan.moves) || !plan.moves.every(move => isRecord(move) && typeof move.from === "string" && typeof move.to === "string" && typeof move.directory === "boolean")
    || !Array.isArray(plan.issues) || !plan.issues.every(issue => isRecord(issue) && typeof issue.path === "string" && typeof issue.reason === "string")) {
    throw new ExplorerError("protocolInvalid");
  }
  return plan as unknown as RenamePlan;
}
