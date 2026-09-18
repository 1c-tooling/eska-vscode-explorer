/** Stable status values from the built-in vscode.git API v1. */
export interface GitStatus { badge: string; color: string; message: "gitModified" | "gitAdded" | "gitDeleted" | "gitRenamed" | "gitConflict"; priority: number }

/** Preserve native Git theme colors, with conflicts winning over other states. */
export function gitStatus(status: number): GitStatus | undefined {
  if (status >= 12 && status <= 18) return { badge: "!", color: "conflictingResourceForeground", message: "gitConflict", priority: 5 };
  switch (status) {
    case 0: return { badge: "M", color: "stageModifiedResourceForeground", message: "gitModified", priority: 2 };
    case 1: case 4: return { badge: "A", color: "addedResourceForeground", message: "gitAdded", priority: 1 };
    case 2: return { badge: "D", color: "stageDeletedResourceForeground", message: "gitDeleted", priority: 4 };
    case 3: case 10: return { badge: "R", color: "renamedResourceForeground", message: "gitRenamed", priority: 3 };
    case 5: case 11: return { badge: "M", color: "modifiedResourceForeground", message: "gitModified", priority: 2 };
    case 6: return { badge: "D", color: "deletedResourceForeground", message: "gitDeleted", priority: 4 };
    case 7: case 9: return { badge: "U", color: "untrackedResourceForeground", message: "gitAdded", priority: 1 };
    default: return undefined;
  }
}
