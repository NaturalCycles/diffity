import { createHash } from 'node:crypto';
import { getDiffStat, getDiffStatForRef, getHeadHash, getUntrackedFiles } from '@diffity/git';

/**
 * A diffstat only counts lines, so a commit that rewrites the same number of them produces an
 * identical stat and the diff would look unchanged. Including the head commit makes any new
 * commit visible, while the stat still catches edits to the working tree, where HEAD does not move.
 */
export function computeDiffFingerprint(
  ref: string | null,
  diffArgs: string[] = [],
  includeUntracked = false,
): string {
  let stat: string;

  if (ref) {
    stat = getDiffStatForRef(ref);
  } else {
    stat = getDiffStat(diffArgs);
    if (includeUntracked) {
      stat += '\n' + getUntrackedFiles().join('\n');
    }
  }

  return createHash('sha1').update(`${getHeadHash()}\n${stat}`).digest('hex');
}
