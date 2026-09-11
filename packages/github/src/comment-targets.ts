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
  /** Who wrote it, so another reviewer's remark is not mistaken for one of ours. */
  login: string;
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

/** What makes a finding one already sent, beyond the line it would sit on. */
export interface PostedBefore {
  /** The findings diffity's own record says have gone to this pull request. */
  threadIds?: ReadonlySet<string>;
  /** The account the review is posted as, when it is known. */
  viewerLogin?: string | null;
}

/**
 * Whether this finding is already on the pull request, as opposed to a new remark about a line
 * that happens to carry one. A line collects comments over rounds — resolved ones, other
 * reviewers' — so its position says nothing about which finding is there, and dropping on
 * position alone silently swallows new findings.
 *
 * Identity settles it where there is a record: a finding diffity sent is not sent twice, however
 * it has been reworded since, because the forge cannot update the comment already there. Where
 * there is no record — a finding imported from a bundle, or posted from another machine — the
 * same wording in the same place from the same account is the best evidence left.
 */
export function isAlreadyCommented(
  existing: ExistingComment[],
  comment: PrComment,
  posted: PostedBefore = {},
): boolean {
  if (comment.threadId && posted.threadIds?.has(comment.threadId)) {
    return true;
  }

  return existing.some(
    one =>
      one.path === comment.filePath &&
      one.line === comment.endLine &&
      one.side === comment.side &&
      sameWording(one.body, comment.body) &&
      (!posted.viewerLogin || one.login === posted.viewerLogin),
  );
}

/** Line endings and trailing space differ between what was sent and what comes back. */
function sameWording(one: string, other: string): boolean {
  return one.replace(/\r\n/g, '\n').trim() === other.replace(/\r\n/g, '\n').trim();
}
