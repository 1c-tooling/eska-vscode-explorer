import type { TreeEntry } from "../tree.js";
import { queryKey } from "./client.js";
import type { QueryHeader, QueryIdentity } from "./protocol.js";

export interface QueryBranch { queryKind: "branch"; key: string; owner: TreeEntry; header: QueryHeader }
export interface QueryLeaf { queryKind: "query"; key: string; owner: TreeEntry; header: QueryHeader; parent: QueryBranch }
export type QueryEntry = QueryBranch | QueryLeaf;

/** Dataset union paths and list names remain backend identities, independent of localized display labels. */
export function queryLabel(identity: QueryIdentity): string {
  return identity.kind === "dataSet" ? identity.path.join(" / ") : identity.kind === "dynamicList" ? identity.name : "SDBL";
}

/** UI-only rows do not introduce synthetic metadata nodes into the backend contract. */
export function queryBranches(owner: TreeEntry, headers: QueryHeader[]): QueryBranch[] {
  return headers.map(header => ({ queryKind: "branch", key: `${owner.key}:query:${queryKey(header.identity)}`, owner, header }));
}

/** The query leaf opens the shared owner session rather than a second physical source file. */
export function queryLeaf(parent: QueryBranch): QueryLeaf {
  return { queryKind: "query", key: `${parent.key}:text`, owner: parent.owner, header: parent.header, parent };
}
