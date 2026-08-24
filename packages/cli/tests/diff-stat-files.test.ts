import { describe, it, expect } from 'vitest';
import { parseDiffStatFiles } from '../src/diff-stat.js';

describe('reading a diffstat file by file', () => {
  const stat = [
    ' packages/cli/src/live.ts        | 24 ++++++++++++++---',
    ' packages/ui/src/lib/api.ts      |  2 +-',
    ' 2 files changed, 26 insertions(+), 1 deletion(-)',
  ].join('\n');

  it('picks out each file and what changed in it', () => {
    const files = parseDiffStatFiles(stat);

    expect(Object.keys(files).sort()).toEqual([
      'packages/cli/src/live.ts',
      'packages/ui/src/lib/api.ts',
    ]);
  });

  it('leaves out the summary line, which is not a file', () => {
    expect(parseDiffStatFiles(stat)['2 files changed, 26 insertions(+), 1 deletion(-)']).toBeUndefined();
  });

  // What matters is whether a file's line changed, so the value is its own churn and nothing else.
  it('gives a file a different value when its own churn changes', () => {
    const before = parseDiffStatFiles(' a.ts | 2 +-\n 1 file changed');
    const after = parseDiffStatFiles(' a.ts | 9 +++++----\n 1 file changed');

    expect(after['a.ts']).not.toBe(before['a.ts']);
  });

  it('leaves a file alone when only another file changed', () => {
    const before = parseDiffStatFiles(' a.ts | 2 +-\n b.ts | 2 +-\n 2 files changed');
    const after = parseDiffStatFiles(' a.ts | 2 +-\n b.ts | 9 +++++----\n 2 files changed');

    expect(after['a.ts']).toBe(before['a.ts']);
  });

  it('handles a rename, which names two paths on one line', () => {
    const files = parseDiffStatFiles(' src/{old.ts => new.ts} | 0\n 1 file changed');

    expect(Object.keys(files)).toEqual(['src/{old.ts => new.ts}']);
  });

  it('has nothing to say about an empty diff', () => {
    expect(parseDiffStatFiles('')).toEqual({});
  });
});
