export type FileChurn = Record<string, string>;

/**
 * Which files have moved since the reader loaded the diff. In live mode an agent edits while they
 * read, and "files have changed" about the whole diff is nearly useless — the useful thing is
 * which ones, so the rest can be left alone.
 */
export function changedSince(baseline: FileChurn | null, current: FileChurn): string[] {
  if (!baseline) {
    return [];
  }

  const changed = new Set<string>();
  for (const [path, churn] of Object.entries(current)) {
    if (baseline[path] !== churn) {
      changed.add(path);
    }
  }
  for (const path of Object.keys(baseline)) {
    if (!(path in current)) {
      changed.add(path);
    }
  }

  return [...changed].sort();
}

/**
 * Naming the file is the difference between a banner you act on and one you learn to ignore. Past a
 * couple it becomes a count, since a list of paths in a one-line banner is unreadable.
 */
export function staleMessage(files: string[]): string {
  const tail = 'changed since this diff was loaded';

  if (files.length === 0) {
    return `Files have ${tail}`;
  }
  if (files.length === 1) {
    return `${files[0]} ${tail}`;
  }
  if (files.length === 2) {
    return `${files[0]} and ${files[1]} ${tail}`;
  }
  return `${files.length} files ${tail}`;
}
