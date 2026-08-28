import type { Comment, CommentThread } from '../../src/components/comments/types';

/** A wire-complete comment, as the server sends it, with the fields a test cares about on top. */
export function makeComment(overrides: Partial<Comment> = {}): Comment {
  return {
    id: 'c1',
    author: { name: 'Agent', type: 'agent' },
    body: '',
    kind: 'review',
    createdAt: '',
    liveRequestedAt: null,
    liveIntent: null,
    liveClaimedAt: null,
    liveAnsweredAt: null,
    ...overrides,
  };
}

/** A wire-complete thread, as the server sends it, with the fields a test cares about on top. */
export function makeThread(overrides: Partial<CommentThread> = {}): CommentThread {
  return {
    id: 't1',
    sessionId: 'sess',
    filePath: 'src/a.ts',
    side: 'new',
    startLine: 10,
    endLine: 10,
    status: 'open',
    anchorContent: null,
    createdAt: '',
    updatedAt: '',
    submittedAt: null,
    submittedReviewUrl: null,
    submittedHeadSha: null,
    submittedBody: null,
    comments: [],
    ...overrides,
  };
}
