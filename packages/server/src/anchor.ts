// The same rules as the CLI's anchor.ts, over file content read from a commit rather than the
// working tree, which a server does not have.

export interface AnchorRange {
  startLine: number;
  endLine: number;
}

/** Enough of a fingerprint to trust a nearest-match: more than one line, or a substantial one. */
const MIN_DISTINCTIVE_CHARS = 12;

function isDistinctive(anchorLines: string[]): boolean {
  if (anchorLines.length > 1) {
    return true;
  }
  return anchorLines[0].replace(/\s+/g, '').length >= MIN_DISTINCTIVE_CHARS;
}

/**
 * Where a comment's lines went after the file changed under it. Exact matches only; when the same
 * lines appear more than once, the occurrence nearest to where the comment used to be wins, but
 * only for an anchor distinctive enough to identify the code.
 */
export function reanchor(anchorContent: string, fileLines: string[], originalStartLine: number): AnchorRange | null {
  if (anchorContent === '') {
    return null;
  }
  const anchorLines = anchorContent.split('\n');
  const matches: number[] = [];
  for (let i = 0; i + anchorLines.length <= fileLines.length; i++) {
    if (anchorLines.every((line, offset) => fileLines[i + offset] === line)) {
      matches.push(i + 1);
    }
  }
  if (matches.length === 0 || (matches.length > 1 && !isDistinctive(anchorLines))) {
    return null;
  }
  const startLine = matches.reduce((best, candidate) =>
    Math.abs(candidate - originalStartLine) < Math.abs(best - originalStartLine) ? candidate : best,
  );
  return { startLine, endLine: startLine + anchorLines.length - 1 };
}

/** An agent working from hunk headers can overshoot the end, and a range past it renders nowhere. */
export function clampToFile(fileLineCount: number | null, startLine: number, endLine: number): AnchorRange {
  if (!fileLineCount || fileLineCount < 1) {
    return { startLine, endLine };
  }
  const start = Math.min(startLine, fileLineCount);
  return { startLine: start, endLine: Math.max(start, Math.min(endLine, fileLineCount)) };
}

/** A trailing newline splits into an empty string that is not a line. */
export function splitLines(content: string): string[] {
  if (content === '') {
    return [];
  }
  const lines = content.split('\n');
  if (lines[lines.length - 1] === '') {
    lines.pop();
  }
  return lines;
}

export function readAnchor(content: string, startLine: number, endLine: number): string | null {
  return splitLines(content).slice(startLine - 1, endLine).join('\n') || null;
}

/** A rename can happen twice across the commits a review spans; bounded, because a swap would loop. */
export function followRename(path: string, moves: Map<string, string>): string {
  const seen = new Set<string>([path]);
  let current = path;
  while (true) {
    const next = moves.get(current);
    if (!next || seen.has(next)) {
      return current;
    }
    seen.add(next);
    current = next;
  }
}
