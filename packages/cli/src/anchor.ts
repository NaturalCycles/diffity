import { getWorkingTreeFileContent } from '@diffity/git';

export interface AnchorRange {
  startLine: number;
  endLine: number;
}

/**
 * The source lines a comment is attached to, in the same shape the browser stores: the lines
 * themselves, joined, with no line numbers.
 */
export function readAnchor(filePath: string, startLine: number, endLine: number): string | undefined {
  try {
    const lines = getWorkingTreeFileContent(filePath).split('\n');
    const anchor = lines.slice(startLine - 1, endLine).join('\n');
    return anchor || undefined;
  } catch {
    return undefined;
  }
}

/**
 * Finds where a comment's lines went after the file changed under it.
 *
 * The match is exact: a line that was edited is a different line, and guessing at similarity
 * would move a comment onto code it was not written about. When the same lines appear more than
 * once, the occurrence nearest to where the comment used to be wins.
 */
/** Enough of a fingerprint to trust a nearest-match: more than one line, or a substantial one. */
const MIN_DISTINCTIVE_CHARS = 12;

function isDistinctive(anchorLines: string[]): boolean {
  if (anchorLines.length > 1) {
    return true;
  }
  return anchorLines[0].replace(/\s+/g, '').length >= MIN_DISTINCTIVE_CHARS;
}

export function reanchor(
  anchorContent: string,
  fileLines: string[],
  originalStartLine: number,
): AnchorRange | null {
  const anchorLines = anchorContent.split('\n');
  if (anchorContent === '' || anchorLines.length === 0) {
    return null;
  }

  const matches: number[] = [];
  for (let i = 0; i + anchorLines.length <= fileLines.length; i++) {
    if (anchorLines.every((line, offset) => fileLines[i + offset] === line)) {
      matches.push(i + 1);
    }
  }

  if (matches.length === 0) {
    return null;
  }

  // Nearest-match is only safe when the anchor identifies the code. A short one-liner like `}`
  // occurs everywhere, so if it matches in several places the finding stays where it was rather
  // than being reattached to something it was not written about.
  if (matches.length > 1 && !isDistinctive(anchorLines)) {
    return null;
  }

  const startLine = matches.reduce((best, candidate) =>
    Math.abs(candidate - originalStartLine) < Math.abs(best - originalStartLine) ? candidate : best,
  );

  return { startLine, endLine: startLine + anchorLines.length - 1 };
}

export function reanchorInWorkingTree(
  filePath: string,
  anchorContent: string,
  originalStartLine: number,
): AnchorRange | null {
  try {
    return reanchor(anchorContent, getWorkingTreeFileContent(filePath).split('\n'), originalStartLine);
  } catch {
    return null;
  }
}

/**
 * A comment cannot be about lines a file does not have. An agent working from hunk headers can
 * easily overshoot the end, and the result renders nowhere at all, so the range is trimmed to
 * what exists rather than being taken on trust.
 */
export function clampToFile(
  fileLineCount: number | null,
  startLine: number,
  endLine: number,
): AnchorRange {
  if (!fileLineCount || fileLineCount < 1) {
    return { startLine, endLine };
  }

  const start = Math.min(startLine, fileLineCount);
  return { startLine: start, endLine: Math.max(start, Math.min(endLine, fileLineCount)) };
}

/**
 * A file ending in a newline splits into a trailing empty string, which is not a line. Counting
 * it makes every range one too long, and a comment anchored past the end renders nowhere.
 */
export function countLines(content: string): number {
  if (content === '') {
    return 0;
  }

  const lines = content.split('\n');
  if (lines[lines.length - 1] === '') {
    lines.pop();
  }

  return lines.length;
}

export function countWorkingTreeLines(filePath: string): number | null {
  try {
    return countLines(getWorkingTreeFileContent(filePath));
  } catch {
    return null;
  }
}
