import { createHash } from 'node:crypto';
import { getDiffStat, getDiffStatForRef, getHeadHash, getUntrackedFiles } from '@diffity/git';

/**
 * A diffstat only counts lines, so a commit that rewrites the same number of them produces an
 * identical stat and the diff would look unchanged. For a ref-based diff the head commit is
 * folded in to make that visible.
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

  // The head only matters for a ref-based diff, where a new commit changes what the range means
  // without necessarily changing the stat. A working-tree diff changes its own stat whenever its
  // content changes, so folding the head in there would call it stale after any commit at all.
  const head = ref ? getHeadHash() : '';

  return createHash('sha1').update(`${head}\n${stat}`).digest('hex');
}
