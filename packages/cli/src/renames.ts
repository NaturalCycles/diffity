interface FileLike {
  status: string;
  oldPath: string;
  newPath: string;
}

/**
 * Where a file went, for the files git says moved.
 *
 * Threads carry forward across a commit but their file path does not, so a commit that renames a
 * file leaves every finding on it pointing at a path that no longer exists — and a thread whose
 * file is absent from the diff is rendered by nothing, so it goes quiet rather than wrong.
 *
 * Taken from git's own rename detection rather than by matching content, so a thread only ever
 * moves to a file git already said is the same file.
 */
export function renamedPaths(files: FileLike[]): Map<string, string> {
  const moves = new Map<string, string>();

  for (const file of files) {
    if (file.status !== 'renamed' && file.status !== 'copied') continue;
    if (!file.oldPath || !file.newPath || file.oldPath === file.newPath) continue;
    moves.set(file.oldPath, file.newPath);
  }

  return moves;
}

/**
 * A rename can happen twice across the commits a review spans, so the chain is followed. Bounded,
 * because a swap would otherwise loop.
 */
export function followRename(path: string, moves: Map<string, string>): string {
  const seen = new Set<string>([path]);
  let current = path;

  while (true) {
    const next = moves.get(current);
    if (!next || seen.has(next)) return current;
    seen.add(next);
    current = next;
  }
}
