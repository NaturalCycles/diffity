import { describe, it, expect } from 'vitest';
import { threadsResolvedRemotely } from '../src/github-resolution.js';
import type { RemoteThreadState } from '../src/github-resolution.js';

function local(over: Partial<Parameters<typeof threadsResolvedRemotely>[0][number]> = {}) {
  return {
    id: 't1',
    filePath: 'src/a.ts',
    side: 'new',
    endLine: 54,
    status: 'open',
    submittedAt: '2026-08-24T15:37:00Z',
    comments: [{ body: 'P2: the finding' }],
    ...over,
  };
}

function remote(over: Partial<RemoteThreadState> = {}): RemoteThreadState {
  return {
    filePath: 'src/a.ts',
    side: 'new',
    endLine: 54,
    body: 'P2: the finding',
    isResolved: true,
    ...over,
  };
}

describe('threadsResolvedRemotely', () => {
  it('takes a sent thread the author has resolved', () => {
    expect(threadsResolvedRemotely([local()], [remote()])).toEqual(['t1']);
  });

  it('leaves a thread the author has not resolved', () => {
    expect(threadsResolvedRemotely([local()], [remote({ isResolved: false })])).toEqual([]);
  });

  it('leaves a thread that was never sent', () => {
    expect(threadsResolvedRemotely([local({ submittedAt: null })], [remote()])).toEqual([]);
  });

  it('leaves a thread already resolved here, so nothing is written twice', () => {
    expect(threadsResolvedRemotely([local({ status: 'resolved' })], [remote()])).toEqual([]);
  });

  it('does not match a different side or file', () => {
    expect(threadsResolvedRemotely([local()], [remote({ side: 'old' })])).toEqual([]);
    expect(threadsResolvedRemotely([local()], [remote({ filePath: 'src/b.ts' })])).toEqual([]);
  });

  // GitHub nulls the line once a thread goes outdated, and an outdated thread is the usual state of
  // a resolved one. Keyed on the line, this sync would do nothing on the threads it exists for.
  it('matches an outdated thread, which has no line left', () => {
    expect(threadsResolvedRemotely([local()], [remote({ endLine: null })])).toEqual(['t1']);
  });

  it('matches when the code moved under the thread', () => {
    expect(threadsResolvedRemotely([local({ endLine: 54 })], [remote({ endLine: 91 })])).toEqual(['t1']);
  });

  // Two findings can sit on one line, and resolving one must not resolve the other.
  it('tells two findings on the same line apart by their body', () => {
    const threads = [local({ id: 'a' }), local({ id: 'b', comments: [{ body: 'P3: the other one' }] })];

    expect(threadsResolvedRemotely(threads, [remote()])).toEqual(['a']);
  });

  it('matches an amended finding on the wording that was sent', () => {
    const amended = local({ comments: [{ body: 'P2: the finding, reworded' }, { body: 'P2: the finding' }] });

    expect(threadsResolvedRemotely([amended], [remote()])).toEqual(['t1']);
  });
});
