export interface DiffStatSummary {
  files: number;
  insertions: number;
  deletions: number;
}

const EMPTY: DiffStatSummary = { files: 0, insertions: 0, deletions: 0 };

/**
 * Reads git's own summary line. Used to say how much whitespace hiding took out: a filtered diff
 * renders fewer lines than the forge shows, and a reader has to be able to see the difference
 * rather than wonder about it.
 */
export function parseDiffStatSummary(stat: string): DiffStatSummary {
  const summary = stat.trim().split('\n').pop();
  if (!summary) {
    return EMPTY;
  }

  const files = /(\d+) files? changed/.exec(summary);
  if (!files) {
    return EMPTY;
  }

  const insertions = /(\d+) insertions?\(\+\)/.exec(summary);
  const deletions = /(\d+) deletions?\(-\)/.exec(summary);

  return {
    files: Number(files[1]),
    insertions: insertions ? Number(insertions[1]) : 0,
    deletions: deletions ? Number(deletions[1]) : 0,
  };
}

/**
 * A diffstat, file by file: each path against its own churn. One hash for the whole diff can only
 * say that something changed, which in live mode — where an agent edits while you read — means the
 * whole diff is declared stale every time one file moves.
 */
export function parseDiffStatFiles(stat: string): Record<string, string> {
  const files: Record<string, string> = {};

  for (const line of stat.split('\n')) {
    const separator = line.lastIndexOf('|');
    if (separator === -1) {
      continue;
    }
    const path = line.slice(0, separator).trim();
    const churn = line.slice(separator + 1).trim();
    if (path) {
      files[path] = churn;
    }
  }

  return files;
}
