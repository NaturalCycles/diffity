import { describe, it, expect } from 'vitest';
import { reconcile } from '../src/inbox/reconcile.js';
import type { InboxPr } from '../src/inbox/store.js';
import type { PrSnapshot } from '@diffity/github';

function snapshot(over: Partial<PrSnapshot> = {}): PrSnapshot {
  return {
    owner: 'o', repo: 'r', number: 1, title: 'A change', url: 'https://github.com/o/r/pull/1',
    author: 'alice', isBot: false, isDraft: false, state: 'OPEN', headSha: 'aaa', baseRef: 'main',
    additions: 10, deletions: 2, changedFiles: 3, updatedAt: '2026-09-02T10:00:00Z', ...over,
  };
}

function existing(over: Partial<InboxPr> = {}): InboxPr {
  return {
    id: 'o/r#1', owner: 'o', repo: 'r', number: 1, title: 'A change', url: 'https://github.com/o/r/pull/1',
    author: 'alice', isDraft: false, headSha: 'aaa', baseRef: 'main', additions: 10, deletions: 2, changedFiles: 3,
    requested: true, status: 'prepared', statusReason: null, attempts: 0, preparedHeadSha: 'aaa', preparedAt: '2026-09-02T09:00:00Z',
    bundlePath: '/b.json', worktreePath: '/wt', logPath: '/l.log', firstSeenAt: 'x', lastSeenAt: 'y', ...over,
  };
}

describe('reconcile', () => {
  it('queues a new requested pull request for preparation', () => {
    expect(reconcile({ existing: null, snapshot: snapshot(), requested: true, viewerLogin: 'me' }))
      .toEqual({ status: 'queued', reason: null, prepare: true });
  });

  it('never prepares a draft', () => {
    expect(reconcile({ existing: null, snapshot: snapshot({ isDraft: true }), requested: true, viewerLogin: 'me' }))
      .toEqual({ status: 'draft', reason: 'draft', prepare: false });
  });

  it('skips a bot author without spending an agent on it', () => {
    const t = reconcile({ existing: null, snapshot: snapshot({ isBot: true, author: 'ncrobot1' }), requested: true, viewerLogin: 'me' });
    expect(t).toEqual({ status: 'skipped', reason: 'bot author (ncrobot1)', prepare: false });
  });

  it('skips the reviewer\'s own pull request', () => {
    expect(reconcile({ existing: null, snapshot: snapshot({ author: 'me' }), requested: true, viewerLogin: 'me' }))
      .toEqual({ status: 'skipped', reason: 'your own pull request', prepare: false });
  });

  it('leaves a prepared review at the current head alone', () => {
    expect(reconcile({ existing: existing(), snapshot: snapshot(), requested: true, viewerLogin: 'me' })).toBeNull();
  });

  it('re-prepares a prepared review once the head has moved', () => {
    const t = reconcile({ existing: existing({ preparedHeadSha: 'aaa' }), snapshot: snapshot({ headSha: 'bbb' }), requested: true, viewerLogin: 'me' });
    expect(t).toEqual({ status: 'stale', reason: 'the pull request has new commits', prepare: true });
  });

  it('keeps a skip settled until the head moves, then re-decides', () => {
    const settled = existing({ status: 'skipped', preparedHeadSha: null, headSha: 'aaa' });
    expect(reconcile({ existing: settled, snapshot: snapshot({ headSha: 'aaa' }), requested: true, viewerLogin: 'me' })).toBeNull();
    expect(reconcile({ existing: settled, snapshot: snapshot({ headSha: 'ccc' }), requested: true, viewerLogin: 'me' }))
      .toEqual({ status: 'queued', reason: null, prepare: true });
  });

  it('retires a merged pull request the search no longer lists, keeping what was prepared', () => {
    const t = reconcile({ existing: existing(), snapshot: snapshot({ state: 'MERGED' }), requested: false, viewerLogin: 'me' });
    expect(t).toEqual({ status: 'done', reason: 'merged', prepare: false });
  });

  it('hides an open pull request that is no longer requesting the review', () => {
    const t = reconcile({ existing: existing(), snapshot: snapshot({ state: 'OPEN' }), requested: false, viewerLogin: 'me' });
    expect(t).toEqual({ status: 'hidden', reason: 'review no longer requested', prepare: false });
  });

  it('does nothing when the detail view failed this tick', () => {
    expect(reconcile({ existing: existing(), snapshot: null, requested: true, viewerLogin: 'me' })).toBeNull();
  });

  it('re-queues a preparation a previous run left unfinished', () => {
    // preparing/queued at reconcile time can only be a crash or Ctrl-C mid-run; pick it up again.
    expect(reconcile({ existing: existing({ status: 'preparing', preparedHeadSha: null }), snapshot: snapshot(), requested: true, viewerLogin: 'me' }))
      .toEqual({ status: 'queued', reason: null, prepare: true });
    expect(reconcile({ existing: existing({ status: 'queued', preparedHeadSha: null }), snapshot: snapshot(), requested: true, viewerLogin: 'me' }))
      .toEqual({ status: 'queued', reason: null, prepare: true });
  });

  it('retries a failed preparation until the attempt cap, then leaves it', () => {
    const failing = existing({ status: 'failed', preparedHeadSha: null, headSha: 'aaa' });
    expect(reconcile({ existing: failing, snapshot: snapshot({ headSha: 'aaa' }), requested: true, viewerLogin: 'me' })!.prepare).toBe(true);
    expect(reconcile({ existing: { ...failing, attempts: 3 }, snapshot: snapshot({ headSha: 'aaa' }), requested: true, viewerLogin: 'me' })).toBeNull();
    // A new head resets the budget.
    expect(reconcile({ existing: { ...failing, attempts: 3 }, snapshot: snapshot({ headSha: 'ddd' }), requested: true, viewerLogin: 'me' })!.prepare).toBe(true);
  });

  it('keeps a dismissed pull request dismissed, whatever the forge says next', () => {
    const dismissed = existing({ status: 'dismissed', statusReason: 'dismissed by the reviewer' });
    expect(reconcile({ existing: dismissed, snapshot: snapshot({ headSha: 'bbb' }), requested: true, viewerLogin: 'me' })).toBeNull();
    expect(reconcile({ existing: dismissed, snapshot: snapshot(), requested: false, viewerLogin: 'me' })).toBeNull();
  });
});
