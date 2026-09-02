import type { PrSnapshot } from '@diffity/github';
import type { InboxPr, InboxStatus } from './store.js';

/** What one poll decided about one pull request, for the daemon to carry out. */
export interface Transition {
  status: InboxStatus;
  reason: string | null;
  /** True when preparation (or re-preparation) should run for this pull request. */
  prepare: boolean;
}

export interface ReconcileInput {
  /** The row as it stands, or null for one never seen before. */
  existing: InboxPr | null;
  /** The forge's latest word, or null when it still lists the PR but the detail view failed. */
  snapshot: PrSnapshot | null;
  /** Whether this poll's search listed the PR as awaiting the reviewer. */
  requested: boolean;
  viewerLogin: string | null;
}

/**
 * The status a pull request should move to, given what the forge now says and what the inbox
 * already did — the whole decision in one pure function, so every branch is a plain test.
 *
 * Nothing prepares a draft, the reviewer's own pull request, or a bot's. A closed or merged one, or
 * one no longer asking for the review, is retired but keeps whatever was prepared. A new commit
 * makes a prepared review stale and worth redoing. Everything else asked of the reviewer is queued.
 */
export function reconcile(input: ReconcileInput): Transition | null {
  const { existing, snapshot, requested, viewerLogin } = input;

  // Listed by search but the detail view failed this tick: keep the row as it is and try next time.
  if (!snapshot) {
    return null;
  }

  if (!requested) {
    if (snapshot.state === 'MERGED') return retire('done', 'merged');
    if (snapshot.state === 'CLOSED') return retire('done', 'closed');
    // Open, but no longer in the review-requested search: the request was withdrawn or already met.
    return retire('hidden', 'review no longer requested');
  }

  if (snapshot.isDraft) {
    return settle('draft', 'draft');
  }
  if (snapshot.isBot) {
    return settle('skipped', `bot author (${snapshot.author})`);
  }
  if (viewerLogin && snapshot.author && snapshot.author === viewerLogin) {
    return settle('skipped', 'your own pull request');
  }

  // A prepared (or being-prepared, or already-skipped-by-the-agent) review for the current head is
  // left alone; a new commit makes it stale and worth redoing.
  if (existing && existing.preparedHeadSha === snapshot.headSha
    && (existing.status === 'prepared' || existing.status === 'preparing')) {
    return null;
  }
  if (existing && existing.status === 'prepared' && existing.preparedHeadSha !== snapshot.headSha) {
    return { status: 'stale', reason: 'the pull request has new commits', prepare: true };
  }

  // A settled skip stays settled until its head moves; re-running the filter on every poll would
  // just spend the same tokens on the same answer.
  if (existing && existing.status === 'skipped' && existing.headSha === snapshot.headSha) {
    return null;
  }
  if (existing && (existing.status === 'preparing' || existing.status === 'queued')) {
    return null;
  }

  return { status: 'queued', reason: null, prepare: true };
}

function settle(status: InboxStatus, reason: string): Transition {
  return { status, reason, prepare: false };
}

function retire(status: InboxStatus, reason: string): Transition {
  return { status, reason, prepare: false };
}
