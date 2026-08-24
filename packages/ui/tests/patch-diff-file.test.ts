import { describe, it, expect } from 'vitest';
import type { DiffFile, ParsedDiff } from '@diffity/parser';
import { patchDiffFile } from '../src/lib/patch-diff-file';

function file(path: string, additions = 1): DiffFile {
  return {
    oldPath: path, newPath: path, status: 'modified',
    hunks: [], additions, deletions: 0, isBinary: false,
  } as DiffFile;
}

function diff(files: DiffFile[]): ParsedDiff {
  return { files } as ParsedDiff;
}

describe('replacing one file in a loaded diff', () => {
  // The point of the whole exercise: everything the reader has not asked about stays exactly as it
  // was, including the objects, so nothing below it re-renders or loses its place.
  it('swaps the file that moved and leaves the others identical', () => {
    const a = file('a.ts');
    const b = file('b.ts');
    const before = diff([a, b]);
    const fresher = file('b.ts', 9);

    const after = patchDiffFile(before, 'b.ts', fresher);

    expect(after.files[0]).toBe(a);
    expect(after.files[1]).toBe(fresher);
  });

  it('keeps the file in its place in the reading order', () => {
    const before = diff([file('a.ts'), file('b.ts'), file('c.ts')]);

    const after = patchDiffFile(before, 'b.ts', file('b.ts', 4));

    expect(after.files.map(f => f.newPath)).toEqual(['a.ts', 'b.ts', 'c.ts']);
  });

  // An agent can undo its own edit, leaving a file with nothing to show.
  it('drops the file when it no longer differs', () => {
    const before = diff([file('a.ts'), file('b.ts')]);

    const after = patchDiffFile(before, 'b.ts', null);

    expect(after.files.map(f => f.newPath)).toEqual(['a.ts']);
  });

  it('appends a file that was not in the diff before', () => {
    const before = diff([file('a.ts')]);

    const after = patchDiffFile(before, 'new.ts', file('new.ts'));

    expect(after.files.map(f => f.newPath)).toEqual(['a.ts', 'new.ts']);
  });

  it('leaves the diff alone when there is nothing to add or remove', () => {
    const before = diff([file('a.ts')]);

    expect(patchDiffFile(before, 'absent.ts', null)).toBe(before);
  });
});
