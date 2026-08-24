import { describe, it, expect } from 'vitest';
import { requestStateOf, isAside } from '../src/lib/live-mode';
import type { Comment } from '../src/components/comments/types';

function comment(fields: Partial<Comment>): Comment {
  return {
    id: 'c1',
    author: { name: 'You', type: 'user' },
    body: 'what do you mean?',
    createdAt: '2026-08-24T10:00:00.000Z',
    ...fields,
  } as Comment;
}

describe('what a thread says about a request', () => {
  it('says nothing about a comment that asked for nothing', () => {
    expect(requestStateOf(comment({}))).toBeNull();
  });

  it('is waiting once it has been asked', () => {
    expect(requestStateOf(comment({ liveRequestedAt: '2026-08-24T10:00:00.000Z' }))).toBe('waiting');
  });

  it('is being worked on once an agent has taken it', () => {
    expect(requestStateOf(comment({
      liveRequestedAt: '2026-08-24T10:00:00.000Z',
      liveClaimedAt: '2026-08-24T10:00:01.000Z',
    }))).toBe('working');
  });

  it('is done once it has been answered', () => {
    expect(requestStateOf(comment({
      liveRequestedAt: '2026-08-24T10:00:00.000Z',
      liveClaimedAt: '2026-08-24T10:00:01.000Z',
      liveAnsweredAt: '2026-08-24T10:00:09.000Z',
    }))).toBe('answered');
  });

  // A listener that died has its claim cleared, and the request goes back to waiting.
  it('is waiting again when the claim was given up', () => {
    expect(requestStateOf(comment({
      liveRequestedAt: '2026-08-24T10:00:00.000Z',
      liveClaimedAt: null,
    }))).toBe('waiting');
  });
});

describe('telling an aside from a finding', () => {
  it('reads a comment with no kind as part of the review', () => {
    expect(isAside(comment({}))).toBe(false);
  });

  it('knows an aside', () => {
    expect(isAside(comment({ kind: 'aside' }))).toBe(true);
  });
});
