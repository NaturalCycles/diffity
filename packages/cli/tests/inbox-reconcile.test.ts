import { describe, it, expect } from 'vitest';
import { reconcile, titleSkipReason } from '../src/inbox/reconcile.js';
import type { Handled, InboxPr } from '../src/inbox/store.js';
import type { PrCheck, PrSnapshot } from '@diffity/github';

function snapshot(over: Partial<PrSnapshot> = {}): PrSnapshot {
  return {
    owner: 'o', repo: 'r', number: 1, title: 'A change', url: 'https://github.com/o/r/pull/1',
    author: 'alice', isBot: false, isDraft: false, state: 'OPEN', headSha: 'aaa', baseRef: 'main',
    additions: 10, deletions: 2, changedFiles: 3, createdAt: '2026-09-02T10:00:00Z', updatedAt: '2026-09-02T10:00:00Z',
    checks: [], files: [], ...over,
  };
}

function existing(over: Partial<InboxPr> = {}): InboxPr {
  return {
    id: 'o/r#1', owner: 'o', repo: 'r', number: 1, title: 'A change', url: 'https://github.com/o/r/pull/1',
    author: 'alice', isDraft: false, headSha: 'aaa', baseRef: 'main', additions: 10, deletions: 2, changedFiles: 3,
    ciState: null, createdAt: null, updatedAt: null, bumpedAt: null, summary: null, alert: null, requested: true, status: 'prepared', statusReason: null, attempts: 0, preparedHeadSha: 'aaa', preparedAt: '2026-09-02T09:00:00Z',
    bundlePath: '/b.json', worktreePath: '/wt', logPath: '/l.log', firstSeenAt: 'x', lastSeenAt: 'y', ...over,
  };
}

function checks(...pairs: [string, PrCheck['status']][]): PrCheck[] {
  return pairs.map(([name, status]) => ({ name, status }));
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

  it('keeps a dismissed pull request dismissed at that head, retires it with the request, and takes new commits from the top', () => {
    const dismissed = existing({ status: 'dismissed', statusReason: 'dismissed by the reviewer' });
    expect(reconcile({ existing: dismissed, snapshot: snapshot(), requested: true, viewerLogin: 'me' })).toBeNull();
    expect(reconcile({ existing: dismissed, snapshot: snapshot(), requested: false, viewerLogin: 'me' }))
      .toEqual({ status: 'hidden', reason: 'review no longer requested', prepare: false });
    expect(reconcile({ existing: dismissed, snapshot: snapshot({ state: 'MERGED' }), requested: false, viewerLogin: 'me' }))
      .toEqual({ status: 'done', reason: 'merged', prepare: false });
    expect(reconcile({ existing: dismissed, snapshot: snapshot({ headSha: 'bbb' }), requested: true, viewerLogin: 'me' }))
      .toEqual({ status: 'queued', reason: null, prepare: true });
  });

  it('prepares a bumped pull request whatever verdict held it back, drafts apart', () => {
    const bumped = { bumpedAt: '2026-09-07T10:00:00Z' };
    expect(reconcile({ existing: existing({ status: 'skipped', statusReason: 'payments PR', ...bumped }), snapshot: snapshot(), requested: true, viewerLogin: 'me' }))
      .toEqual({ status: 'queued', reason: 'bumped by the reviewer', prepare: true });
    expect(reconcile({ existing: existing({ status: 'skipped', ...bumped }), snapshot: snapshot({ author: 'me' }), requested: true, viewerLogin: 'me' }))
      .toEqual({ status: 'queued', reason: 'bumped by the reviewer', prepare: true });
    expect(reconcile({ existing: existing({ status: 'failed', attempts: 3, ...bumped }), snapshot: snapshot(), requested: true, viewerLogin: 'me' }))
      .toEqual({ status: 'queued', reason: 'bumped by the reviewer', prepare: true });
    expect(reconcile({ existing: existing({ status: 'queued', ...bumped }), snapshot: snapshot({ isDraft: true }), requested: true, viewerLogin: 'me' }))
      .toEqual({ status: 'draft', reason: 'draft', prepare: false });
  });
});

describe('reconcile with waitForCi', () => {
  const running = snapshot({ checks: checks(['check-job', 'pending'], ['e2e', 'pending'], ['lint', 'success']) });
  const failing = snapshot({ checks: checks(['check-job', 'failure'], ['pr-mgmt-job', 'failure'], ['lint', 'success']) });

  it('waits for a run still going rather than spending an agent on it', () => {
    expect(reconcile({ existing: null, snapshot: running, requested: true, viewerLogin: 'me', waitForCi: true }))
      .toEqual({ status: 'queued', reason: 'waiting: CI running (2 checks)', prepare: false });
  });

  it('leaves a failing pull request to its author', () => {
    expect(reconcile({ existing: null, snapshot: failing, requested: true, viewerLogin: 'me', waitForCi: true }))
      .toEqual({ status: 'skipped', reason: 'CI failed: check-job, pr-mgmt-job', prepare: false });
  });

  it('names three failing checks and counts the rest', () => {
    const many = snapshot({ checks: checks(['a', 'failure'], ['b', 'failure'], ['c', 'failure'], ['d', 'failure'], ['e', 'failure']) });
    expect(reconcile({ existing: null, snapshot: many, requested: true, viewerLogin: 'me', waitForCi: true })!.reason)
      .toBe('CI failed: a, b, c and 2 more');
  });

  it('prepares when the checks pass, and when there are none to wait for', () => {
    const green = snapshot({ checks: checks(['check-job', 'success'], ['integration-test-job', 'skipped']) });
    expect(reconcile({ existing: null, snapshot: green, requested: true, viewerLogin: 'me', waitForCi: true }))
      .toEqual({ status: 'queued', reason: null, prepare: true });
    expect(reconcile({ existing: null, snapshot: snapshot(), requested: true, viewerLogin: 'me', waitForCi: true }))
      .toEqual({ status: 'queued', reason: null, prepare: true });
  });

  it('holds nothing back while it is off', () => {
    expect(reconcile({ existing: null, snapshot: failing, requested: true, viewerLogin: 'me' }))
      .toEqual({ status: 'queued', reason: null, prepare: true });
    expect(reconcile({ existing: null, snapshot: running, requested: true, viewerLogin: 'me', waitForCi: false }))
      .toEqual({ status: 'queued', reason: null, prepare: true });
  });

  it('prepares a bumped pull request whatever CI says', () => {
    const bumped = existing({ status: 'queued', preparedHeadSha: null, bumpedAt: '2026-09-07T10:00:00Z' });
    for (const snap of [running, failing]) {
      expect(reconcile({ existing: bumped, snapshot: snap, requested: true, viewerLogin: 'me', waitForCi: true }))
        .toEqual({ status: 'queued', reason: 'bumped by the reviewer', prepare: true });
    }
  });

  it('keeps a review prepared for an older head openable while its refresh waits', () => {
    const prepared = existing({ status: 'prepared', preparedHeadSha: 'aaa' });
    expect(reconcile({ existing: prepared, snapshot: { ...running, headSha: 'bbb' }, requested: true, viewerLogin: 'me', waitForCi: true }))
      .toEqual({ status: 'stale', reason: 'waiting: CI running (2 checks)', prepare: false });
    expect(reconcile({ existing: prepared, snapshot: { ...failing, headSha: 'bbb' }, requested: true, viewerLogin: 'me', waitForCi: true }))
      .toEqual({ status: 'stale', reason: 'CI failed: check-job, pr-mgmt-job', prepare: false });
    // And the row that is already stale stays where the reviewer can open it.
    expect(reconcile({ existing: existing({ status: 'stale', preparedHeadSha: 'aaa', headSha: 'bbb' }), snapshot: { ...failing, headSha: 'bbb' }, requested: true, viewerLogin: 'me', waitForCi: true }))
      .toEqual({ status: 'stale', reason: 'CI failed: check-job, pr-mgmt-job', prepare: false });
  });

  it('re-decides a CI skip every poll, and queues it once the checks pass', () => {
    const held = existing({ status: 'skipped', statusReason: 'CI failed: check-job', preparedHeadSha: null, headSha: 'aaa' });
    expect(reconcile({ existing: held, snapshot: failing, requested: true, viewerLogin: 'me', waitForCi: true }))
      .toEqual({ status: 'skipped', reason: 'CI failed: check-job, pr-mgmt-job', prepare: false });
    expect(reconcile({ existing: held, snapshot: snapshot({ checks: checks(['check-job', 'success']) }), requested: true, viewerLogin: 'me', waitForCi: true }))
      .toEqual({ status: 'queued', reason: null, prepare: true });
    // The reviewer's own filter skip is still settled at that head.
    expect(reconcile({ existing: existing({ status: 'skipped', statusReason: 'payments PR', preparedHeadSha: null, headSha: 'aaa' }), snapshot: snapshot(), requested: true, viewerLogin: 'me', waitForCi: true }))
      .toBeNull();
  });

  it('says nothing about CI on a pull request it would not have prepared anyway', () => {
    expect(reconcile({ existing: null, snapshot: { ...failing, isDraft: true }, requested: true, viewerLogin: 'me', waitForCi: true }))
      .toEqual({ status: 'draft', reason: 'draft', prepare: false });
    expect(reconcile({ existing: existing(), snapshot: { ...failing, state: 'MERGED' }, requested: false, viewerLogin: 'me', waitForCi: true }))
      .toEqual({ status: 'done', reason: 'merged', prepare: false });
  });
});

describe('titleSkipReason', () => {
  it('names the first pattern that matches, and nothing when none does', () => {
    const patterns = ['^fix', '\\(payments\\)', 'Release$'];
    expect(titleSkipReason('feat(payments): a new card', patterns)).toBe('title matches /\\(payments\\)/');
    expect(titleSkipReason('fix(payments): a card', patterns)).toBe('title matches /^fix/');
    expect(titleSkipReason('chore: 1.2.3 Release', patterns)).toBe('title matches /Release$/');
    expect(titleSkipReason('feat: a new card', patterns)).toBeNull();
    expect(titleSkipReason('anything at all', [])).toBeNull();
  });

  it('reads each entry as a regular expression, matched as written', () => {
    // The parentheses are the title's, not a group: an escaped source is what the reviewer writes.
    expect(titleSkipReason('feat[payments]: a card', ['\\(payments\\)'])).toBeNull();
    // Unanchored and case-sensitive, both as JavaScript has it.
    expect(titleSkipReason('a release of everything', ['Release$'])).toBeNull();
    expect(titleSkipReason('DEV-1 chore: bump deps', ['^DEV-\\d+ '])).toBe('title matches /^DEV-\\d+ /');
  });

  it('ignores a pattern that does not compile rather than failing the poll', () => {
    // The config refuses one; a pattern that reached here anyway must not cost the whole tick.
    expect(titleSkipReason('(payments) a card', ['(payments', '\\(payments\\)']))
      .toBe('title matches /\\(payments\\)/');
  });
});

describe('reconcile with skipTitles', () => {
  const patterns = ['\\(payments\\)', 'Release$'];

  it('skips a matching title before an agent is spent on it', () => {
    expect(reconcile({ existing: null, snapshot: snapshot({ title: 'feat(payments): a new card' }), requested: true, viewerLogin: 'me', skipTitles: patterns }))
      .toEqual({ status: 'skipped', reason: 'title matches /\\(payments\\)/', prepare: false });
  });

  it('prepares a title no pattern matches, and everything when there are no patterns', () => {
    expect(reconcile({ existing: null, snapshot: snapshot({ title: 'feat: a new card' }), requested: true, viewerLogin: 'me', skipTitles: patterns }))
      .toEqual({ status: 'queued', reason: null, prepare: true });
    expect(reconcile({ existing: null, snapshot: snapshot({ title: 'feat(payments): a new card' }), requested: true, viewerLogin: 'me' }))
      .toEqual({ status: 'queued', reason: null, prepare: true });
  });

  it('prepares a bumped pull request whatever its title says', () => {
    const bumped = existing({ status: 'skipped', statusReason: 'title matches /\\(payments\\)/', preparedHeadSha: null, bumpedAt: '2026-09-07T10:00:00Z' });
    expect(reconcile({ existing: bumped, snapshot: snapshot({ title: 'feat(payments): a new card' }), requested: true, viewerLogin: 'me', skipTitles: patterns }))
      .toEqual({ status: 'queued', reason: 'bumped by the reviewer', prepare: true });
  });

  it('re-decides a title skip every poll, so a retitled pull request goes back in the queue', () => {
    const held = existing({ status: 'skipped', statusReason: 'title matches /\\(payments\\)/', preparedHeadSha: null, headSha: 'aaa' });
    expect(reconcile({ existing: held, snapshot: snapshot({ title: 'feat(payments): a new card' }), requested: true, viewerLogin: 'me', skipTitles: patterns }))
      .toEqual({ status: 'skipped', reason: 'title matches /\\(payments\\)/', prepare: false });
    expect(reconcile({ existing: held, snapshot: snapshot({ title: 'feat: a new card' }), requested: true, viewerLogin: 'me', skipTitles: patterns }))
      .toEqual({ status: 'queued', reason: null, prepare: true });
  });

  it('answers a matching title before CI, with nothing to wait for', () => {
    const failing = snapshot({ title: 'chore: 1.2.3 Release', checks: checks(['check-job', 'failure']) });
    expect(reconcile({ existing: null, snapshot: failing, requested: true, viewerLogin: 'me', waitForCi: true, skipTitles: patterns }))
      .toEqual({ status: 'skipped', reason: 'title matches /Release$/', prepare: false });
    const running = snapshot({ title: 'chore: 1.2.3 Release', checks: checks(['check-job', 'pending']) });
    expect(reconcile({ existing: null, snapshot: running, requested: true, viewerLogin: 'me', waitForCi: true, skipTitles: patterns }))
      .toEqual({ status: 'skipped', reason: 'title matches /Release$/', prepare: false });
  });

  it('keeps a review prepared for an older head openable, as the CI hold does', () => {
    const prepared = existing({ status: 'prepared', preparedHeadSha: 'aaa' });
    expect(reconcile({ existing: prepared, snapshot: snapshot({ title: 'feat(payments): a new card', headSha: 'bbb' }), requested: true, viewerLogin: 'me', skipTitles: patterns }))
      .toEqual({ status: 'stale', reason: 'title matches /\\(payments\\)/', prepare: false });
    expect(reconcile({ existing: existing({ status: 'stale', preparedHeadSha: 'aaa', headSha: 'bbb' }), snapshot: snapshot({ title: 'feat(payments): a new card', headSha: 'ccc' }), requested: true, viewerLogin: 'me', skipTitles: patterns }))
      .toEqual({ status: 'stale', reason: 'title matches /\\(payments\\)/', prepare: false });
  });

  it('says nothing about the title on a pull request it would not have prepared anyway', () => {
    expect(reconcile({ existing: null, snapshot: snapshot({ title: 'feat(payments): a new card', isDraft: true }), requested: true, viewerLogin: 'me', skipTitles: patterns }))
      .toEqual({ status: 'draft', reason: 'draft', prepare: false });
    expect(reconcile({ existing: existing(), snapshot: snapshot({ title: 'feat(payments): a new card', state: 'MERGED' }), requested: false, viewerLogin: 'me', skipTitles: patterns }))
      .toEqual({ status: 'done', reason: 'merged', prepare: false });
  });
});

describe('a pull request whose review diffity posted', () => {
  function handled(over: Partial<Handled> = {}): Handled {
    return {
      headSha: 'aaa', event: 'APPROVE',
      reviewUrl: 'https://github.com/o/r/pull/1#pullrequestreview-9',
      at: '2026-09-02T12:00:00Z', ...over,
    };
  }

  const notRequested = { requested: false, viewerLogin: 'me' } as const;

  it('stays listed as handled instead of being hidden', () => {
    expect(reconcile({ existing: existing(), snapshot: snapshot(), ...notRequested, handled: handled() }))
      .toEqual({ status: 'handled', reason: 'you approved', prepare: false });
  });

  it('says what was said, and whether the author has pushed since', () => {
    const said = [
      ['APPROVE', 'you approved'],
      ['REQUEST_CHANGES', 'you requested changes'],
      ['COMMENT', 'you commented'],
    ] as const;
    for (const [event, phrase] of said) {
      expect(reconcile({ existing: existing(), snapshot: snapshot(), ...notRequested, handled: handled({ event }) }))
        .toEqual({ status: 'handled', reason: phrase, prepare: false });
      expect(reconcile({ existing: existing(), snapshot: snapshot({ headSha: 'bbb' }), ...notRequested, handled: handled({ event }) }))
        .toEqual({ status: 'handled', reason: `new commits since ${phrase}`, prepare: false });
    }
  });

  it('is retired once it is merged or closed', () => {
    expect(reconcile({ existing: existing(), snapshot: snapshot({ state: 'MERGED' }), ...notRequested, handled: handled() }))
      .toEqual({ status: 'done', reason: 'merged', prepare: false });
    expect(reconcile({ existing: existing(), snapshot: snapshot({ state: 'CLOSED' }), ...notRequested, handled: handled() }))
      .toEqual({ status: 'done', reason: 'closed', prepare: false });
  });

  it('stays dismissed while its head is unchanged, and comes back when it moves', () => {
    const dismissed = existing({ status: 'dismissed', headSha: 'aaa' });
    expect(reconcile({ existing: dismissed, snapshot: snapshot({ headSha: 'aaa' }), ...notRequested, handled: handled() })).toBeNull();
    expect(reconcile({ existing: dismissed, snapshot: snapshot({ headSha: 'bbb' }), ...notRequested, handled: handled() }))
      .toEqual({ status: 'handled', reason: 'new commits since you approved', prepare: false });
  });

  it('leaves a bump\'s preparation to own the row', () => {
    for (const status of ['queued', 'preparing'] as const) {
      expect(reconcile({ existing: existing({ status }), snapshot: snapshot(), ...notRequested, handled: handled() })).toBeNull();
    }
  });

  it('leaves a review prepared since the posting openable, until that one is posted too', () => {
    const bumped = existing({ status: 'prepared', preparedAt: '2026-09-02T13:00:00Z' });
    expect(reconcile({ existing: bumped, snapshot: snapshot(), ...notRequested, handled: handled({ at: '2026-09-02T12:00:00Z' }) })).toBeNull();
    expect(reconcile({ existing: existing({ status: 'stale', preparedAt: '2026-09-02T13:00:00Z' }), snapshot: snapshot(), ...notRequested, handled: handled({ at: '2026-09-02T12:00:00Z' }) })).toBeNull();
    expect(reconcile({ existing: bumped, snapshot: snapshot(), ...notRequested, handled: handled({ at: '2026-09-02T14:00:00Z' }) }))
      .toEqual({ status: 'handled', reason: 'you approved', prepare: false });
  });

  it('goes back in the queue when the author asks for another review', () => {
    const settled = existing({ status: 'handled', statusReason: 'you approved', preparedHeadSha: null, preparedAt: null });
    expect(reconcile({ existing: settled, snapshot: snapshot({ headSha: 'bbb' }), requested: true, viewerLogin: 'me', handled: handled() }))
      .toEqual({ status: 'queued', reason: null, prepare: true });
  });

  it('is skipped by title, and held by CI, like anything else the author asks about again', () => {
    const settled = existing({ status: 'handled', statusReason: 'you approved', preparedHeadSha: null, preparedAt: null });
    expect(reconcile({
      existing: settled, snapshot: snapshot({ headSha: 'bbb', title: 'chore: 1.2.3 Release' }),
      requested: true, viewerLogin: 'me', handled: handled(), skipTitles: ['Release$'],
    })).toEqual({ status: 'skipped', reason: 'title matches /Release$/', prepare: false });
    expect(reconcile({
      existing: settled, snapshot: snapshot({ headSha: 'bbb', checks: checks(['check-job', 'failure']) }),
      requested: true, viewerLogin: 'me', handled: handled(), waitForCi: true,
    })).toEqual({ status: 'skipped', reason: 'CI failed: check-job', prepare: false });
  });
});
