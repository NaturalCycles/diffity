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
    expect(store.handledIds()).toEqual([]);

    store.recordHandled(mark({ event: 'COMMENT', at: '2026-09-08T09:00:00.000Z' }));
    store.recordHandled(mark({ headSha: 'bbb', at: '2026-09-08T11:00:00.000Z' }));
    store.recordHandled(mark({ prId: 'o/r#2', event: 'REQUEST_CHANGES', reviewUrl: null, at: '2026-09-08T10:00:00.000Z' }));

    expect(store.latestHandled('o/r#1')).toEqual({
      headSha: 'bbb', event: 'APPROVE',
      reviewUrl: 'https://github.com/o/r/pull/1#pullrequestreview-9', at: '2026-09-08T11:00:00.000Z',
    });
    expect(store.latestHandled('o/r#2')?.reviewUrl).toBeNull();
    expect(store.handledIds()).toEqual(['o/r#1', 'o/r#2']);
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
    expect(store.handledIds()).toEqual(['o/r#3']);
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
      at: '2026-09-08T09:00:00.000Z', summary: '1 P2', alert: null,
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
      at: '2026-09-08T10:00:00.000Z', summary: '1 P2', alert: null,
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

describe('diffity inbox status', () => {
  it('prints a Handled section with what was said about each one', async () => {
    process.env.DIFFITY_DATA_DIR = join(dir, 'data');
    const store = new InboxStore(inboxStorePath());
    store.observe(snapshot({ headSha: 'bbb' }), false, 'now');
    store.recordHandled(mark({ headSha: 'aaa' }));
    store.setStatus('o/r#1', 'handled', 'new commits since you approved');
    store.close();

    const lines: string[] = [];
    const log = vi.spyOn(console, 'log').mockImplementation((message: unknown) => { lines.push(String(message)); });
    const program = new Command();
    registerInboxCommand(program);
    await program.parseAsync(['node', 'diffity', 'inbox', 'status']);
    log.mockRestore();

    const printed = lines.join('\n');
    expect(printed).toContain('Handled');
    expect(printed).toContain('updated');
    expect(printed).toContain('r#1 A change');
    expect(printed).toContain('new commits since you approved');
    expect(printed).not.toContain('Nothing in the inbox yet');
  });
});
