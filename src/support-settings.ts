/** Merge only extension-owned entries; all other user rules remain byte-for-value intact. */
export function reconcileRules(current: Record<string, boolean>, owned: readonly string[], desired: readonly string[]): { rules: Record<string, boolean>; owned: string[] } {
  const rules = { ...current };
  const previous = new Set(owned);
  for (const key of previous) if (rules[key] === true) delete rules[key];
  const next: string[] = [];
  for (const key of desired) {
    if (!(key in rules)) { rules[key] = true; next.push(key); }
  }
  return { rules, owned: next };
}

/** Literal absolute paths cannot accidentally match a sibling project or a glob metacharacter. */
export function readonlyPattern(path: string): string {
  return path.replaceAll('\\', '/').replace(/[?*\[\]{},]/g, c => `[${c}]`);
}

/** Bound setting keys while retaining an exact, project-scoped list of protected files. */
export function readonlyPatterns(source: string, paths: readonly string[]): string[] {
  const prefix = source.replaceAll('\\', '/').replace(/\/$/, '') + '/';
  const sorted = [...new Set(paths)].sort();
  if (sorted.length <= 128 || sorted.some(path => !path.replaceAll('\\', '/').startsWith(prefix))) return sorted.map(readonlyPattern);
  const result: string[] = [];
  for (let offset = 0; offset < sorted.length; offset += 128) {
    const batch = sorted.slice(offset, offset + 128);
    const relative = batch.map(path => path.replaceAll('\\', '/').slice(prefix.length));
    result.push(readonlyPattern(prefix) + '{' + relative.map(readonlyPattern).join(',') + '}');
  }
  return result;
}
