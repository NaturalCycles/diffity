import type { PrSnapshot } from '@diffity/github';
import type { InboxPr, InboxStatus } from './store.js';

/** How many times preparation is retried at one head before the pull request is left as failed. */
export const MAX_PREPARE_ATTEMPTS = 3;

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
    if (snapshot.state === 'MERGED') return settled('done', 'merged');
    if (snapshot.state === 'CLOSED') return settled('done', 'closed');
    // Open, but no longer in the review-requested search: the request was withdrawn or already met.
    return settled('hidden', 'review no longer requested');
  }

  if (snapshot.isDraft) {
    return settled('draft', 'draft');
  }
  if (snapshot.isBot) {
    return settled('skipped', `bot author (${snapshot.author})`);
  }
  if (viewerLogin && snapshot.author && snapshot.author === viewerLogin) {
    return settled('skipped', 'your own pull request');
  }

  // A review already prepared for the current head is left alone; a new commit makes it stale and
  // worth redoing.
  if (existing && existing.status === 'prepared') {
    return existing.preparedHeadSha === snapshot.headSha
      ? null
      : { status: 'stale', reason: 'the pull request has new commits', prepare: true };
  }

  // A settled skip stays settled until its head moves; re-running the filter on every poll would
  // just spend the same tokens on the same answer.
  if (existing && existing.status === 'skipped' && existing.headSha === snapshot.headSha) {
    return null;
  }

  // Failures are retried, but not without bound: a PR whose preparation keeps failing at one head
  // stops being retried after a few attempts, rather than spending an agent every poll forever.
  if (existing && existing.status === 'failed' && existing.headSha === snapshot.headSha
    && existing.attempts >= MAX_PREPARE_ATTEMPTS) {
    return null;
  }

  // `queued`, `preparing` and `stale` are in-flight states: at reconcile time — one tick reconciles
  // before it prepares, and the tick is non-reentrant — they can only be a run the previous process
  // did not finish (a Ctrl-C, a crash). Re-queue it rather than leave it stuck forever.
  return { status: 'queued', reason: null, prepare: true };
}

/** A resolved status that needs no preparation — a skip, a draft, or a retirement. */
function settled(status: InboxStatus, reason: string): Transition {
  return { status, reason, prepare: false };
}
