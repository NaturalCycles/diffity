import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Command } from 'commander';
import type { PrSnapshot } from '@diffity/github';
import { recordHandledReview } from '../src/inbox/handled.js';
import { inboxStorePath } from '../src/inbox/paths.js';
import { InboxStore, prIdToRef, type HandledMark } from '../src/inbox/store.js';
import { buildView } from '../src/inbox/view.js';
import { registerInboxCommand } from '../src/commands/inbox.js';

let dir: string;
let path: string;

function snapshot(over: Partial<PrSnapshot> = {}): PrSnapshot {
  return {
    owner: 'o', repo: 'r', number: 1, title: 'A change', url: 'https://github.com/o/r/pull/1',
    author: 'alice', isBot: false, isDraft: false, state: 'OPEN', headSha: 'aaa', baseRef: 'main',
    additions: 10, deletions: 2, changedFiles: 3, createdAt: '2026-09-02T10:00:00Z', updatedAt: '2026-09-02T10:00:00Z',
    checks: [], files: [], ...over,
  };
}

function mark(over: Partial<HandledMark> = {}): HandledMark {
  return {
    prId: 'o/r#1', headSha: 'aaa', event: 'APPROVE',
    reviewUrl: 'https://github.com/o/r/pull/1#pullrequestreview-9',
    at: '2026-09-08T10:00:00.000Z', ...over,
  };
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'diffity-handled-'));
  path = join(dir, 'inbox.sqlite');
});

afterEach(() => {
  delete process.env.DIFFITY_DATA_DIR;
  rmSync(dir, { recursive: true, force: true });
});

describe('the handled log', () => {
  it('keeps every mark and reads back the latest one per pull request', () => {
    const store = new InboxStore(path);
    expect(store.latestHandled('o/r#1')).toBeNull();
    expect(store.unadoptedHandledIds()).toEqual([]);

    store.recordHandled(mark({ event: 'COMMENT', at: '2026-09-08T09:00:00.000Z' }));
    store.recordHandled(mark({ headSha: 'bbb', at: '2026-09-08T11:00:00.000Z' }));
    store.recordHandled(mark({ prId: 'o/r#2', event: 'REQUEST_CHANGES', reviewUrl: null, at: '2026-09-08T10:00:00.000Z' }));

    expect(store.latestHandled('o/r#1')).toEqual({
      headSha: 'bbb', event: 'APPROVE',
      reviewUrl: 'https://github.com/o/r/pull/1#pullrequestreview-9', at: '2026-09-08T11:00:00.000Z',
    });
    expect(store.latestHandled('o/r#2')?.reviewUrl).toBeNull();
    expect(store.unadoptedHandledIds()).toEqual(['o/r#1', 'o/r#2']);
    store.close();
  });

  it('shows the daemon a mark the posting process wrote while it had the store open', () => {
    const daemon = new InboxStore(path);
    expect(daemon.latestHandled('o/r#1')).toBeNull();

    recordHandledReview({
      owner: 'o', repo: 'r', number: 1, headSha: 'aaa', event: 'REQUEST_CHANGES',
      reviewUrl: 'https://github.com/o/r/pull/1#pullrequestreview-9',
      now: '2026-09-08T10:00:00.000Z', storePath: path,
    });

    expect(daemon.latestHandled('o/r#1')).toEqual({
      headSha: 'aaa', event: 'REQUEST_CHANGES',
      reviewUrl: 'https://github.com/o/r/pull/1#pullrequestreview-9', at: '2026-09-08T10:00:00.000Z',
    });
    daemon.close();
  });

  it('writes to the reviewer\'s own inbox when no store is named', () => {
    process.env.DIFFITY_DATA_DIR = join(dir, 'data');

    recordHandledReview({
      owner: 'o', repo: 'r', number: 3, headSha: 'ccc', event: 'APPROVE', reviewUrl: null,
      now: '2026-09-08T10:00:00.000Z',
    });

    const store = new InboxStore(inboxStorePath());
    expect(store.unadoptedHandledIds()).toEqual(['o/r#3']);
    store.close();
  });

  it('leaves out the marks a listed row already carries, and keeps the hidden ones', () => {
    const store = new InboxStore(path);
    for (const number of [1, 2, 3, 4]) {
      store.observe(snapshot({ number }), false, 'now');
      store.recordHandled(mark({ prId: `o/r#${number}` }));
    }
    store.setStatus('o/r#1', 'handled', 'you approved');
    store.setStatus('o/r#2', 'hidden', 'review no longer requested');
    store.setStatus('o/r#3', 'done', 'merged');
    store.setStatus('o/r#4', 'dismissed', null);
    store.recordHandled(mark({ prId: 'o/r#5' }));

    // The hidden one is out of the poll's reach, so the adoption pass has to pick it up; a merged
    // one is done with, and the rest are listed already.
    expect(store.unadoptedHandledIds()).toEqual(['o/r#2', 'o/r#5']);
    store.close();
  });

  it('reads a mark from a build that posted some other kind of review as something said', () => {
    const seed = new InboxStore(path);
    seed.close();
    const raw = new DatabaseSync(path);
    raw.prepare('INSERT INTO inbox_handled (pr_id, head_sha, event, review_url, at) VALUES (?, ?, ?, ?, ?)')
      .run('o/r#1', 'aaa', 'DISMISS', null, '2026-09-08T10:00:00.000Z');
    raw.close();

    const store = new InboxStore(path);
    expect(store.latestHandled('o/r#1')?.event).toBe('COMMENT');
    store.close();
  });
});

describe('prIdToRef', () => {
  it('reads a row id back as the ref it names', () => {
    expect(prIdToRef('NaturalCycles/NCBackend3#14231'))
      .toEqual({ owner: 'NaturalCycles', repo: 'NCBackend3', number: 14231 });
    expect(prIdToRef('o/r')).toBeNull();
    expect(prIdToRef('o/r#x')).toBeNull();
  });
});

describe('the handled list', () => {
  /** A row the daemon has settled as handled, with the mark behind it. */
  function handledRow(store: InboxStore, over: Partial<PrSnapshot>, over2: Partial<HandledMark> = {}): void {
    const snap = snapshot(over);
    store.observe(snap, false, 'now');
    store.recordHandled(mark({ prId: `o/r#${snap.number}`, ...over2 }));
    store.setStatus(`o/r#${snap.number}`, 'handled', 'you approved');
  }

  it('lists a handled row with the mark, and takes it out of the other groups', () => {
    const store = new InboxStore(':memory:');
    handledRow(store, {});

    const view = buildView(store, 'http://localhost:5390', 'now');
    expect(view.handled.map(row => row.id)).toEqual(['o/r#1']);
    expect(view.other).toEqual([]);
    expect(view.ready).toEqual([]);
    expect(view.handled[0].handled).toEqual({
      headSha: 'aaa', event: 'APPROVE',
      reviewUrl: 'https://github.com/o/r/pull/1#pullrequestreview-9',
      at: '2026-09-08T10:00:00.000Z', updated: false,
    });
    // Nothing local left to open, but it can be reviewed again or set aside.
    expect(view.handled[0].openUrl).toBeNull();
    expect(view.handled[0].prepareUrl).toBe('http://localhost:5390/prepare/o%2Fr%231');
    expect(view.handled[0].dismissUrl).toBe('http://localhost:5390/dismiss/o%2Fr%231');
    store.close();
  });

  it('marks a row the author has pushed to since the review as updated', () => {
    const store = new InboxStore(':memory:');
    handledRow(store, { headSha: 'bbb' }, { headSha: 'aaa' });

    expect(buildView(store, 'http://localhost:5390', 'now').handled[0].handled?.updated).toBe(true);
    store.close();
  });

  it('takes a prepared review the reviewer has posted out of ready before the next poll', () => {
    const store = new InboxStore(':memory:');
    store.observe(snapshot(), true, 'now');
    store.markPrepared('o/r#1', {
      headSha: 'aaa', bundlePath: '/b', worktreePath: '/wt', logPath: '/l',
      at: '2026-09-08T09:00:00.000Z', summary: '1 P2', alert: null, alertFindings: [],
    });

    expect(buildView(store, 'http://localhost:5390', 'now').ready.map(row => row.id)).toEqual(['o/r#1']);

    store.recordHandled(mark({ at: '2026-09-08T10:00:00.000Z' }));
    const view = buildView(store, 'http://localhost:5390', 'now');
    expect(view.ready).toEqual([]);
    expect(view.handled.map(row => row.id)).toEqual(['o/r#1']);
    store.close();
  });

  it('leaves a review prepared after the last posting in ready', () => {
    const store = new InboxStore(':memory:');
    store.observe(snapshot(), true, 'now');
    store.recordHandled(mark({ at: '2026-09-08T09:00:00.000Z' }));
    store.markPrepared('o/r#1', {
      headSha: 'aaa', bundlePath: '/b', worktreePath: '/wt', logPath: '/l',
      at: '2026-09-08T10:00:00.000Z', summary: '1 P2', alert: null, alertFindings: [],
    });

    const view = buildView(store, 'http://localhost:5390', 'now');
    expect(view.ready.map(row => row.id)).toEqual(['o/r#1']);
    expect(view.handled).toEqual([]);
    store.close();
  });

  it('puts the ones with new commits first, then the most recently reviewed', () => {
    const store = new InboxStore(':memory:');
    handledRow(store, { number: 1 }, { at: '2026-09-08T09:00:00.000Z' });
    handledRow(store, { number: 2 }, { at: '2026-09-08T11:00:00.000Z' });
    handledRow(store, { number: 3, headSha: 'zzz' }, { at: '2026-09-08T08:00:00.000Z' });

    expect(buildView(store, 'http://localhost:5390', 'now').handled.map(row => row.id))
      .toEqual(['o/r#3', 'o/r#2', 'o/r#1']);
    store.close();
  });
});

describe('the alerted list', () => {
  /** A prepared review, with whatever the agent raised about it. */
  function preparedRow(
    store: InboxStore,
    over: Partial<PrSnapshot>,
    prepared: { at: string; alert?: string; alertFindings?: string[] },
  ): void {
    const snap = snapshot(over);
    store.observe(snap, true, 'now');
    store.markPrepared(`o/r#${snap.number}`, {
      headSha: snap.headSha, bundlePath: '/b', worktreePath: '/wt', logPath: '/l', at: prepared.at,
      summary: '1 P1', alert: prepared.alert ?? null, alertFindings: prepared.alertFindings ?? [],
    });
  }

  it('lists the alerted ones most recently prepared first, leaving the rest ready', () => {
    const store = new InboxStore(':memory:');
    preparedRow(store, { number: 1, additions: 1, deletions: 0 }, { at: '2026-09-08T09:00:00.000Z', alert: 'touches auth', alertFindings: ['cf15e689'] });
    preparedRow(store, { number: 2 }, { at: '2026-09-08T10:00:00.000Z' });
    preparedRow(store, { number: 3, additions: 900, deletions: 0 }, { at: '2026-09-08T11:00:00.000Z', alert: 'a P1 in payments' });

    const view = buildView(store, 'http://localhost:5390', 'now');
    // The largest of the three, and the newest: size orders the ready list, not this one.
    expect(view.alerted.map(row => [row.number, row.alertFindings])).toEqual([[3, []], [1, ['cf15e689']]]);
    expect(view.ready.map(row => row.number)).toEqual([2]);
    expect(view.other).toEqual([]);
    store.close();
  });

  it('keeps a stale alerted review listed, and lets a posted one go to handled', () => {
    const store = new InboxStore(':memory:');
    preparedRow(store, {}, { at: '2026-09-08T09:00:00.000Z', alert: 'touches auth' });
    store.observe(snapshot({ headSha: 'bbb' }), true, 'now');

    const pushed = buildView(store, 'http://localhost:5390', 'now');
    expect(pushed.alerted.map(row => [row.id, row.stale])).toEqual([['o/r#1', true]]);

    store.recordHandled(mark({ at: '2026-09-08T10:00:00.000Z' }));
    const posted = buildView(store, 'http://localhost:5390', 'now');
    expect(posted.alerted).toEqual([]);
    expect(posted.ready).toEqual([]);
    expect(posted.handled.map(row => row.id)).toEqual(['o/r#1']);
    store.close();
  });
});

describe('diffity inbox status', () => {
  /** Everything the command printed, as one string. */
  async function statusOutput(): Promise<string> {
    const lines: string[] = [];
    const log = vi.spyOn(console, 'log').mockImplementation((message: unknown) => { lines.push(String(message)); });
    const program = new Command();
    registerInboxCommand(program);
    await program.parseAsync(['node', 'diffity', 'inbox', 'status']);
    log.mockRestore();
    return lines.join('\n');
  }

  it('prints a Handled section with what was said about each one', async () => {
    process.env.DIFFITY_DATA_DIR = join(dir, 'data');
    const store = new InboxStore(inboxStorePath());
    store.observe(snapshot({ headSha: 'bbb' }), false, 'now');
    store.recordHandled(mark({ headSha: 'aaa' }));
    store.setStatus('o/r#1', 'handled', 'new commits since you approved');
    store.close();

    const printed = await statusOutput();
    expect(printed).toContain('Handled');
    expect(printed).toContain('updated');
    expect(printed).toContain('r#1 A change');
    expect(printed).toContain('new commits since you approved');
    expect(printed).not.toContain('Nothing in the inbox yet');
  });

  it('prints an Alerted section above Ready, with the reason and the findings named', async () => {
    process.env.DIFFITY_DATA_DIR = join(dir, 'data');
    const store = new InboxStore(inboxStorePath());
    for (const number of [1, 2]) {
      store.observe(snapshot({ number, title: number === 1 ? 'Touch auth' : 'A tidy-up' }), true, 'now');
      store.markPrepared(`o/r#${number}`, {
        headSha: 'aaa', bundlePath: '/b', worktreePath: '/wt', logPath: '/l', at: 'now', summary: '1 P1',
        alert: number === 1 ? 'touches auth' : null, alertFindings: number === 1 ? ['cf15e689', '7b2a10c4'] : [],
      });
    }
    store.close();

    const printed = await statusOutput();
    expect(printed).toContain('Alerted');
    expect(printed).toContain('touches auth');
    expect(printed).toContain('2 findings');
    expect(printed.indexOf('Alerted')).toBeLessThan(printed.indexOf('Ready to review'));
    // The one nothing was raised about is still listed, below.
    expect(printed).toContain('A tidy-up');
  });
});
