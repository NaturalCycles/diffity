import { describe, it, expect } from 'vitest';
import { parseDiffStatSummary } from '../src/diff-stat.js';

describe('parseDiffStatSummary', () => {
  it('reads the summary line git prints', () => {
    const stat = ' src/a.ts | 4 ++--\n src/b.ts | 2 +-\n 2 files changed, 3 insertions(+), 3 deletions(-)\n';

    expect(parseDiffStatSummary(stat)).toEqual({ files: 2, insertions: 3, deletions: 3 });
  });

  it('handles insertions only', () => {
    const stat = ' a | 1 +\n 1 file changed, 1 insertion(+)\n';

    expect(parseDiffStatSummary(stat)).toEqual({ files: 1, insertions: 1, deletions: 0 });
  });

  it('handles deletions only', () => {
    const stat = ' a | 1 -\n 1 file changed, 1 deletion(-)\n';

    expect(parseDiffStatSummary(stat)).toEqual({ files: 1, insertions: 0, deletions: 1 });
  });

  it('reads zero out of an empty stat', () => {
    expect(parseDiffStatSummary('')).toEqual({ files: 0, insertions: 0, deletions: 0 });
  });
});
