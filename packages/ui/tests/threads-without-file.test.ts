import { describe, it, expect } from 'vitest';
import { threadsWithoutFile } from '../src/lib/threads-without-file';
import { GENERAL_THREAD_FILE_PATH } from '../src/components/comments/types';
import type { CommentThread } from '../src/components/comments/types';

function thread(over: Partial<CommentThread> = {}): CommentThread {
  return {
    id: 't1',
    filePath: 'src/a.ts',
    side: 'new',
    startLine: 1,
    endLine: 1,
    status: 'open',
    comments: [],
    ...over,
  } as CommentThread;
}

const inDiff = ['src/a.ts', 'src/b.ts'];

describe('threadsWithoutFile', () => {
  it('finds one whose file is gone', () => {
    const lost = thread({ id: 'lost', filePath: 'src/renamed-away.ts' });

    expect(threadsWithoutFile([thread(), lost], inDiff).map(t => t.id)).toEqual(['lost']);
  });

  it('leaves the ones whose file is there', () => {
    expect(threadsWithoutFile([thread(), thread({ filePath: 'src/b.ts' })], inDiff)).toEqual([]);
  });

  it('is not about general comments, which have no file', () => {
    expect(threadsWithoutFile([thread({ filePath: GENERAL_THREAD_FILE_PATH })], inDiff)).toEqual([]);
  });

  // Already dealt with. The file going away is not a reason to ask again.
  it('ignores resolved and dismissed ones', () => {
    const gone = { filePath: 'src/gone.ts' };

    expect(threadsWithoutFile(
      [thread({ ...gone, status: 'resolved' }), thread({ ...gone, status: 'dismissed' })],
      inDiff,
    )).toEqual([]);
  });

  it('reports everything when the diff is empty', () => {
    expect(threadsWithoutFile([thread()], []).map(t => t.filePath)).toEqual(['src/a.ts']);
  });
});
