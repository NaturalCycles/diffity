import { describe, it, expect } from 'vitest';
import {
  liveModeKey,
  readLiveMode,
  writeLiveMode,
  requestStateOf,
  isAside,
} from '../src/lib/live-mode';
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

function fakeStorage(): Storage {
  const map = new Map<string, string>();
  return {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    removeItem: (k: string) => void map.delete(k),
    clear: () => map.clear(),
    key: () => null,
    length: 0,
  } as unknown as Storage;
}

describe('remembering live mode', () => {
  // Left on while working on your own repo, it must not still be on when the next tab is
  // somebody else's pull request.
  it('remembers it per checkout and branch', () => {
    const store = fakeStorage();
    writeLiveMode(store, '/home/me/proj', 'feature-a', true);

    expect(readLiveMode(store, '/home/me/proj', 'feature-a')).toBe(true);
    expect(readLiveMode(store, '/home/me/proj', 'feature-b')).toBe(false);
    expect(readLiveMode(store, '/home/me/other', 'feature-a')).toBe(false);
  });

  it('is off until it is turned on', () => {
    expect(readLiveMode(fakeStorage(), '/home/me/proj', 'main')).toBe(false);
  });

  it('can be turned back off', () => {
    const store = fakeStorage();
    writeLiveMode(store, '/p', 'b', true);
    writeLiveMode(store, '/p', 'b', false);

    expect(readLiveMode(store, '/p', 'b')).toBe(false);
  });

  it('keys on both, so neither alone collides', () => {
    expect(liveModeKey('/p', 'b')).not.toBe(liveModeKey('/p', 'c'));
    expect(liveModeKey('/p', 'b')).not.toBe(liveModeKey('/q', 'b'));
  });
});

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
