import { describe, expect, it } from 'vitest';
import type { CommentThread, PrComment } from '@diffity/api';
import {
  commentableLines,
  existingThreadFor,
  groupPulledThreads,
  isAlreadyCommented,
  matchCreatedComments,
  threadsResolvedRemotely,
  toReviewPayload,
} from '../src/github-review.js';
import type { ReviewComment } from '../src/github.js';

const PATCH = `diff --git a/src.ts b/src.ts
index 1111111..2222222 100644
--- a/src.ts
+++ b/src.ts
@@ -1,3 +1,3 @@
 one
-two
+TWO
 three
diff --git a/gone.ts b/gone.ts
deleted file mode 100644
index 3333333..0000000
--- a/gone.ts
+++ /dev/null
@@ -1 +0,0 @@
-bye
`;

function remote(overrides: Partial<ReviewComment> = {}): ReviewComment {
  return {
    id: 1, path: 'src.ts', line: 2, startLine: null, side: 'RIGHT', body: 'Finding', inReplyToId: null,
    login: 'me', isBot: false, createdAt: '2026-09-01T00:00:00Z', ...overrides,
  };
}

function prComment(overrides: Partial<PrComment> = {}): PrComment {
  return { threadId: 't1', filePath: 'src.ts', side: 'RIGHT', startLine: null, endLine: 2, body: 'Finding', ...overrides };
}

function thread(overrides: Partial<CommentThread> = {}): CommentThread {
  return {
    id: 't1', sessionId: 's', filePath: 'src.ts', side: 'new', startLine: 2, endLine: 2, status: 'open', anchorContent: null,
    createdAt: '', updatedAt: '', submittedAt: null, submittedReviewUrl: null, submittedBody: null, submittedHeadSha: null,
    githubCommentId: null,
    comments: [{ id: 'c', author: { name: 'a', type: 'agent' }, body: 'Finding', kind: 'review', createdAt: '' }],
    ...overrides,
  };
}

describe('commentableLines', () => {
  it('lists both sides of every hunk line, a deleted file under its old path', () => {
    const lines = commentableLines(PATCH);
    expect([...lines.get('src.ts')!.RIGHT].sort()).toEqual([1, 2, 3]);
    expect([...lines.get('src.ts')!.LEFT].sort()).toEqual([1, 2, 3]);
    expect([...lines.get('gone.ts')!.LEFT]).toEqual([1]);
    expect(commentableLines('  ').size).toBe(0);
  });
});

describe('toReviewPayload', () => {
  it('sends a range only when it spans lines', () => {
    expect(toReviewPayload(prComment())).toEqual({ path: 'src.ts', side: 'RIGHT', line: 2, body: 'Finding' });
    expect(toReviewPayload(prComment({ startLine: 1 }))).toMatchObject({ start_line: 1, start_side: 'RIGHT', line: 2 });
    expect(toReviewPayload(prComment({ startLine: 2 }))).not.toHaveProperty('start_line');
  });
});

describe('isAlreadyCommented', () => {
  const none = { threadIds: new Set<string>(), viewerLogin: 'me' };

  it('knows a finding by its record, however reworded', () => {
    expect(isAlreadyCommented([], prComment({ body: 'Reworded' }), { threadIds: new Set(['t1']), viewerLogin: null })).toBe(true);
  });

  it('otherwise by the same wording on the same line from the same account', () => {
    expect(isAlreadyCommented([remote({ body: 'Finding\r\n' })], prComment(), none)).toBe(true);
    expect(isAlreadyCommented([remote({ login: 'someone-else' })], prComment(), none)).toBe(false);
    expect(isAlreadyCommented([remote({ body: 'Another remark' })], prComment(), none)).toBe(false);
    expect(isAlreadyCommented([remote({ line: 3 })], prComment(), none)).toBe(false);
    expect(isAlreadyCommented([remote({ login: 'someone-else' })], prComment(), { threadIds: new Set(), viewerLogin: null })).toBe(true);
  });
});

describe('matchCreatedComments', () => {
  it('pairs identical findings with created comments in order, each once', () => {
    const sent = [
      { threadId: 'a', path: 'src.ts', body: 'Same', endLine: 2 },
      { threadId: 'b', path: 'src.ts', body: 'Same', endLine: 2 },
      { threadId: 'c', path: 'src.ts', body: 'Lost', endLine: 2 },
    ];
    const created = [remote({ id: 10, body: 'Same' }), remote({ id: 11, body: 'Same', line: null })];
    expect(matchCreatedComments(sent, created)).toEqual([
      { threadId: 'a', githubCommentId: 10 },
      { threadId: 'b', githubCommentId: 11 },
    ]);
  });
});

describe('groupPulledThreads', () => {
  it('makes threads of roots on a line and their replies, leaving outdated roots out', () => {
    const threads = groupPulledThreads([
      remote({ id: 1, startLine: 1, side: 'LEFT' }),
      remote({ id: 2, inReplyToId: 1, body: 'Reply', login: 'bot', isBot: true }),
      remote({ id: 3, line: null, body: 'Outdated' }),
    ]);
    expect(threads).toEqual([{
      filePath: 'src.ts', side: 'old', startLine: 1, endLine: 2, firstCommentId: 1,
      comments: [
        { body: 'Finding', authorName: 'me', authorType: 'user' },
        { body: 'Reply', authorName: 'bot', authorType: 'agent' },
      ],
    }]);
  });
});

describe('existingThreadFor', () => {
  const pulled = groupPulledThreads([remote({ id: 7 })])[0];

  it('finds a thread by its GitHub id, else by place and wording', () => {
    expect(existingThreadFor([thread({ githubCommentId: 7, filePath: 'elsewhere.ts' })], pulled)?.id).toBe('t1');
    expect(existingThreadFor([thread()], pulled)?.id).toBe('t1');
    expect(existingThreadFor([thread({ startLine: 1 })], pulled)).toBeUndefined();
    expect(existingThreadFor([thread({ githubCommentId: 8, comments: [] })], pulled)).toBeUndefined();
  });
});

describe('threadsResolvedRemotely', () => {
  const state = { filePath: 'src.ts', side: 'new' as const, endLine: null, body: 'As sent', isResolved: true, firstCommentId: null };

  it('resolves only open threads that were sent, by id or by the wording sent', () => {
    expect(threadsResolvedRemotely([thread({ submittedAt: 'x', githubCommentId: 5 })], [{ ...state, firstCommentId: 5 }])).toEqual(['t1']);
    expect(threadsResolvedRemotely([thread({ submittedAt: 'x', githubCommentId: 5 })], [{ ...state, firstCommentId: 6 }])).toEqual([]);
    expect(threadsResolvedRemotely([thread({ submittedAt: 'x', submittedBody: 'As sent' })], [state])).toEqual(['t1']);
    expect(threadsResolvedRemotely([thread({ submittedAt: 'x' })], [{ ...state, body: 'Finding' }])).toEqual(['t1']);
    expect(threadsResolvedRemotely([thread({ submittedAt: 'x', status: 'dismissed' })], [state])).toEqual([]);
    expect(threadsResolvedRemotely([thread({ submittedBody: 'As sent' })], [state])).toEqual([]);
    expect(threadsResolvedRemotely([thread({ submittedAt: 'x', submittedBody: 'As sent' })], [{ ...state, isResolved: false }])).toEqual([]);
  });
});
