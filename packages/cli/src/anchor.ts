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
