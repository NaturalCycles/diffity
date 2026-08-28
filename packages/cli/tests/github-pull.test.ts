import { describe, it, expect } from 'vitest';
import type { CommentThread } from '@diffity/api';
import type { PulledThread } from '@diffity/github';
import { existingThreadFor } from '../src/github-pull.js';

function local(over: Partial<CommentThread> = {}): CommentThread {
  return {
    id: 't1',
    sessionId: 's',
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
    githubCommentId: null,
    comments: [{
      id: 'c1',
      author: { name: 'Agent', type: 'agent' },
      body: 'P2: the finding',
      kind: 'review',
      createdAt: '',
      liveRequestedAt: null,
      liveIntent: null,
      liveClaimedAt: null,
      liveAnsweredAt: null,
    }],
    ...over,
  };
}

function remote(over: Partial<PulledThread> = {}): PulledThread {
  return {
    filePath: 'src/a.ts',
    side: 'new',
    startLine: 10,
    endLine: 10,
    firstCommentId: 900,
    comments: [{ body: 'P2: the finding', authorName: 'Agent', authorType: 'agent', createdAt: '' }],
    ...over,
  };
}

describe('existingThreadFor', () => {
  it('recognises a thread by the forge comment id whatever its wording says now', () => {
    const amended = local({ githubCommentId: 900, comments: [] });

    expect(existingThreadFor([amended], remote())).toBe(amended);
  });

  it('still takes a wording twin even when the ids disagree, rather than duplicating the thread', () => {
    const other = local({ githubCommentId: 901 });

    // The wording fallback still matches it: an id mismatch alone must not create a duplicate,
    // because both heuristics agreeing on "same position, same words" is the pre-id identity.
    expect(existingThreadFor([other], remote())).toBe(other);
  });

  it('falls back to position and wording for a thread sent before ids were recorded', () => {
    const legacy = local();

    expect(existingThreadFor([legacy], remote())).toBe(legacy);
  });

  it('finds nothing for a genuinely new remote thread', () => {
    expect(existingThreadFor([local()], remote({ startLine: 99, endLine: 99, firstCommentId: 901, comments: [{ body: 'something else', authorName: 'A', authorType: 'user', createdAt: '' }] }))).toBeUndefined();
  });
});
