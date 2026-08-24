import type { DiffFile, ParsedDiff } from '@diffity/parser';
import { getFilePath } from './diff-utils';

/**
 * Replaces one file in a loaded diff, leaving every other file the same object. That identity is
 * the point: reloading the whole diff to see one changed file costs the reader their collapse
 * states, their place, and a re-render of everything.
 *
 * A null replacement means the file no longer differs — an agent undoing its own edit does that.
 */
export function patchDiffFile(diff: ParsedDiff, filePath: string, fresh: DiffFile | null): ParsedDiff {
  const index = diff.files.findIndex(file => getFilePath(file) === filePath);

  if (index === -1) {
    return fresh ? { ...diff, files: [...diff.files, fresh] } : diff;
  }

  const files = [...diff.files];
  if (fresh) {
    files[index] = fresh;
  } else {
    files.splice(index, 1);
  }

  return { ...diff, files };
}
