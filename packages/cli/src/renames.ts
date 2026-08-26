/**
 * Where a file went, from `git diff -M --name-status`.
 *
 * Threads carry forward across a commit but their file path does not, so a commit that renames a
 * file leaves every finding on it pointing at a path that no longer exists — and a thread whose
 * file is absent from the diff is rendered by nothing, so it goes quiet rather than wrong.
 *
 * `--name-status` rather than the diff body: this runs on a poll, and the answer is a few hundred
 * bytes either way. Renames only, never copies — a copy leaves the original in place, so following
 * one would take a finding off the file it was written about.
 */
export function renamedPaths(nameStatus: string): Map<string, string> {
  const moves = new Map<string, string>();

  for (const line of nameStatus.split('\n')) {
    const [status, from, to] = line.split('\t');
    if (!status?.startsWith('R') || !from || !to || from === to) continue;
    moves.set(from, to);
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
