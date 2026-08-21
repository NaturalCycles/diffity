import { parseDiff } from '@diffity/parser';
import type { PrComment } from './types.js';

export interface CommentableSides {
  RIGHT: Set<number>;
  LEFT: Set<number>;
}

export interface ExistingComment {
  path: string;
  line: number;
  side: string;
  body: string;
}

/**
 * The lines a review comment may be attached to, per file. The forge rejects a comment on a line
 * outside the pull request's own diff, and one rejection fails the whole review — so a comment
 * that cannot land has to be found before submitting rather than after.
 */
export function commentableLines(patch: string): Map<string, CommentableSides> {
  const byFile = new Map<string, CommentableSides>();

  if (!patch.trim()) {
    return byFile;
  }

  for (const file of parseDiff(patch).files) {
    const path = file.status === 'deleted' ? file.oldPath : file.newPath;
    const sides: CommentableSides = { RIGHT: new Set(), LEFT: new Set() };

    for (const hunk of file.hunks) {
      for (const line of hunk.lines) {
        if (line.newLineNumber !== null) {
          sides.RIGHT.add(line.newLineNumber);
        }
        if (line.oldLineNumber !== null) {
          sides.LEFT.add(line.oldLineNumber);
        }
      }
    }

    byFile.set(path, sides);
  }

  return byFile;
}

/**
 * Matched on position rather than wording: editing a finding locally and submitting again is not
 * a new remark about that line, and the forge has no way to update the one already there.
 */
export function isAlreadyCommented(existing: ExistingComment[], comment: PrComment): boolean {
  return existing.some(
    one =>
      one.path === comment.filePath &&
      one.line === comment.endLine &&
      one.side === comment.side,
  );
}
