import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { InboxStore, runRecordOf, type RunRecord } from '../src/inbox/store.js';
import type { RunStats } from '../src/inbox/agent-output.js';
import type { PrSnapshot } from '@diffity/github';

let dir: string;
let path: string;

function snapshot(): PrSnapshot {
  return {
    owner: 'o', repo: 'r', number: 1, title: 'T', body: '', url: 'https://github.com/o/r/pull/1',
    author: 'alice', isBot: false, isDraft: false, state: 'OPEN', headSha: 'aaa', baseRef: 'main',
    additions: 1, deletions: 0, changedFiles: 1, createdAt: 'now', updatedAt: 'now', checks: [], files: [],
  };
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'diffity-store-'));
  path = join(dir, 'inbox.sqlite');
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('InboxStore migration', () => {
  it('adds the attempts column to a table created before it existed', () => {
    // An old-schema table without `attempts`, as an earlier build would have written.
    const seed = new DatabaseSync(path);
    seed.exec(`CREATE TABLE inbox_prs (
      id TEXT PRIMARY KEY, owner TEXT NOT NULL, repo TEXT NOT NULL, number INTEGER NOT NULL,
      title TEXT NOT NULL, url TEXT NOT NULL, author TEXT NOT NULL, is_draft INTEGER NOT NULL,
      head_sha TEXT NOT NULL, base_ref TEXT NOT NULL, additions INTEGER NOT NULL, deletions INTEGER NOT NULL,
      changed_files INTEGER NOT NULL, requested INTEGER NOT NULL, status TEXT NOT NULL, status_reason TEXT,
      prepared_head_sha TEXT, prepared_at TEXT, bundle_path TEXT, worktree_path TEXT, log_path TEXT,
      first_seen_at TEXT NOT NULL, last_seen_at TEXT NOT NULL)`);
    seed.close();

    const store = new InboxStore(path);
    const pr = store.observe(snapshot(), true, 'now');
    expect(pr.attempts).toBe(0);
    store.failAttempt(pr.id, 'boom');
    expect(store.get(pr.id)!.attempts).toBe(1);
    store.close();
  });

  it('adds the forge timestamps to a table created before they were kept', () => {
    const seed = new DatabaseSync(path);
    seed.exec(`CREATE TABLE inbox_prs (
      id TEXT PRIMARY KEY, owner TEXT NOT NULL, repo TEXT NOT NULL, number INTEGER NOT NULL,
      title TEXT NOT NULL, url TEXT NOT NULL, author TEXT NOT NULL, is_draft INTEGER NOT NULL,
      head_sha TEXT NOT NULL, base_ref TEXT NOT NULL, additions INTEGER NOT NULL, deletions INTEGER NOT NULL,
      changed_files INTEGER NOT NULL, requested INTEGER NOT NULL, status TEXT NOT NULL, status_reason TEXT,
      attempts INTEGER NOT NULL DEFAULT 0, prepared_head_sha TEXT, prepared_at TEXT, bundle_path TEXT,
      worktree_path TEXT, log_path TEXT, first_seen_at TEXT NOT NULL, last_seen_at TEXT NOT NULL)`);
    seed.exec(`INSERT INTO inbox_prs (id, owner, repo, number, title, url, author, is_draft, head_sha, base_ref,
      additions, deletions, changed_files, requested, status, first_seen_at, last_seen_at)
      VALUES ('o/r#1', 'o', 'r', 1, 'T', 'u', 'alice', 0, 'aaa', 'main', 1, 0, 1, 1, 'queued', 'x', 'y')`);
    seed.close();

    const store = new InboxStore(path);
    expect(store.get('o/r#1')!.createdAt).toBeNull();
    const pr = store.observe({ ...snapshot(), createdAt: '2026-09-01T08:00:00Z', updatedAt: '2026-09-02T10:00:00Z' }, true, 'now');
    expect(pr.createdAt).toBe('2026-09-01T08:00:00Z');
    expect(pr.updatedAt).toBe('2026-09-02T10:00:00Z');
    store.close();
  });

  it('keeps what CI said about the head, on a table that predates the column', () => {
    const seed = new DatabaseSync(path);
    seed.exec(`CREATE TABLE inbox_prs (
      id TEXT PRIMARY KEY, owner TEXT NOT NULL, repo TEXT NOT NULL, number INTEGER NOT NULL,
      title TEXT NOT NULL, url TEXT NOT NULL, author TEXT NOT NULL, is_draft INTEGER NOT NULL,
      head_sha TEXT NOT NULL, base_ref TEXT NOT NULL, additions INTEGER NOT NULL, deletions INTEGER NOT NULL,
      changed_files INTEGER NOT NULL, requested INTEGER NOT NULL, status TEXT NOT NULL, status_reason TEXT,
      attempts INTEGER NOT NULL DEFAULT 0, prepared_head_sha TEXT, prepared_at TEXT, bundle_path TEXT,
      worktree_path TEXT, log_path TEXT, first_seen_at TEXT NOT NULL, last_seen_at TEXT NOT NULL)`);
    seed.close();

    const store = new InboxStore(path);
    expect(store.observe(snapshot(), true, 'now').ciState).toBe('none');
    expect(store.observe({ ...snapshot(), checks: [{ name: 'check-job', status: 'failure' }] }, true, 'now').ciState).toBe('failing');
    // A new commit with its checks still going: what the page shows follows the head.
    expect(store.observe({ ...snapshot(), headSha: 'bbb', checks: [{ name: 'check-job', status: 'pending' }] }, true, 'now').ciState).toBe('running');
    expect(store.get('o/r#1')!.ciState).toBe('running');
    store.close();
  });

  it('bumps a row to queued and remembers when, until the bump is spent', () => {
    const store = new InboxStore(path);
    store.observe(snapshot(), true, 'now');
    store.setStatus('o/r#1', 'skipped', 'payments PR');
    expect(store.get('o/r#1')!.bumpedAt).toBeNull();

    store.bump('o/r#1', '2026-09-07T10:00:00Z');
    const bumped = store.get('o/r#1')!;
    expect(bumped.status).toBe('queued');
    expect(bumped.statusReason).toBe('bumped by the reviewer');
    expect(bumped.bumpedAt).toBe('2026-09-07T10:00:00Z');

    store.clearBump('o/r#1');
    expect(store.get('o/r#1')!.bumpedAt).toBeNull();
    store.close();
  });

  it('opens a fresh database and round-trips a prepared row', () => {
    const store = new InboxStore(path);
    store.observe(snapshot(), true, 'now');
    store.markPrepared('o/r#1', { headSha: 'aaa', bundlePath: '/b', worktreePath: '/wt', logPath: '/l', at: 'now', summary: '1 P1', alert: 'touches auth', alertFindings: ['cf15e689', '7b2a10c4'] });
    const pr = store.get('o/r#1')!;
    expect(pr.status).toBe('prepared');
    expect(pr.preparedHeadSha).toBe('aaa');
    expect(pr.attempts).toBe(0);
    expect(pr.summary).toBe('1 P1');
    expect(pr.alert).toBe('touches auth');
    expect(pr.alertFindings).toEqual(['cf15e689', '7b2a10c4']);
    store.close();
  });

  it('takes the findings behind an alert on a table that predates the column', () => {
    const seed = new DatabaseSync(path);
    seed.exec(`CREATE TABLE inbox_prs (
      id TEXT PRIMARY KEY, owner TEXT NOT NULL, repo TEXT NOT NULL, number INTEGER NOT NULL,
      title TEXT NOT NULL, url TEXT NOT NULL, author TEXT NOT NULL, is_draft INTEGER NOT NULL,
      head_sha TEXT NOT NULL, base_ref TEXT NOT NULL, additions INTEGER NOT NULL, deletions INTEGER NOT NULL,
      changed_files INTEGER NOT NULL, requested INTEGER NOT NULL, status TEXT NOT NULL, status_reason TEXT,
      attempts INTEGER NOT NULL DEFAULT 0, prepared_head_sha TEXT, prepared_at TEXT, bundle_path TEXT,
      worktree_path TEXT, log_path TEXT, first_seen_at TEXT NOT NULL, last_seen_at TEXT NOT NULL,
      summary TEXT, alert TEXT)`);
    seed.exec(`INSERT INTO inbox_prs (id, owner, repo, number, title, url, author, is_draft, head_sha, base_ref,
      additions, deletions, changed_files, requested, status, first_seen_at, last_seen_at, alert)
      VALUES ('o/r#1', 'o', 'r', 1, 'T', 'u', 'alice', 0, 'aaa', 'main', 1, 0, 1, 1, 'prepared', 'x', 'y', 'touches auth')`);
    seed.close();

    const store = new InboxStore(path);
    expect(store.get('o/r#1')!.alertFindings).toEqual([]);
    store.markPrepared('o/r#1', { headSha: 'aaa', bundlePath: '/b', worktreePath: '/wt', logPath: '/l', at: 'now', summary: '1 P1', alert: 'touches auth', alertFindings: ['cf15e689'] });
    expect(store.get('o/r#1')!.alertFindings).toEqual(['cf15e689']);
    store.close();
  });

  it('remembers the head the alert findings were posted for, and the review they went out in', () => {
    const store = new InboxStore(path);
    store.observe(snapshot(), true, 'now');
    expect(store.get('o/r#1')!.autoPosted).toBeNull();

    store.markAutoPosted('o/r#1', {
      at: '2026-09-02T12:00:00.000Z', headSha: 'aaa',
      url: 'https://github.com/o/r/pull/1#pullrequestreview-9',
    });
    expect(store.get('o/r#1')!.autoPosted).toEqual({
      at: '2026-09-02T12:00:00.000Z', headSha: 'aaa',
      url: 'https://github.com/o/r/pull/1#pullrequestreview-9',
    });

    // The next head overwrites it: what the column answers is whether this head has been posted to.
    store.markAutoPosted('o/r#1', { at: '2026-09-02T13:00:00.000Z', headSha: 'bbb', url: null });
    expect(store.get('o/r#1')!.autoPosted).toEqual({ at: '2026-09-02T13:00:00.000Z', headSha: 'bbb', url: null });
    store.close();
  });

  it('takes a posted review on a table that predates the columns', () => {
    const seed = new DatabaseSync(path);
    seed.exec(`CREATE TABLE inbox_prs (
      id TEXT PRIMARY KEY, owner TEXT NOT NULL, repo TEXT NOT NULL, number INTEGER NOT NULL,
      title TEXT NOT NULL, url TEXT NOT NULL, author TEXT NOT NULL, is_draft INTEGER NOT NULL,
      head_sha TEXT NOT NULL, base_ref TEXT NOT NULL, additions INTEGER NOT NULL, deletions INTEGER NOT NULL,
      changed_files INTEGER NOT NULL, requested INTEGER NOT NULL, status TEXT NOT NULL, status_reason TEXT,
      attempts INTEGER NOT NULL DEFAULT 0, prepared_head_sha TEXT, prepared_at TEXT, bundle_path TEXT,
      worktree_path TEXT, log_path TEXT, first_seen_at TEXT NOT NULL, last_seen_at TEXT NOT NULL,
      summary TEXT, alert TEXT, alert_findings TEXT)`);
    seed.close();

    const store = new InboxStore(path);
    store.observe(snapshot(), true, 'now');
    expect(store.get('o/r#1')!.autoPosted).toBeNull();
    store.markAutoPosted('o/r#1', { at: '2026-09-02T12:00:00.000Z', headSha: 'aaa', url: null });
    expect(store.get('o/r#1')!.autoPosted).toEqual({ at: '2026-09-02T12:00:00.000Z', headSha: 'aaa', url: null });
    store.close();
  });

  it('reads a findings column that does not name a list of ids as naming none', () => {
    const store = new InboxStore(path);
    store.observe(snapshot(), true, 'now');
    store.close();

    for (const [written, expected] of [['not json', []], ['{"a":1}', []], ['["cf15e689", 3]', ['cf15e689']]] as const) {
      const raw = new DatabaseSync(path);
      raw.prepare('UPDATE inbox_prs SET alert_findings = ? WHERE id = ?').run(written, 'o/r#1');
      raw.close();
      const reopened = new InboxStore(path);
      expect(reopened.get('o/r#1')!.alertFindings).toEqual(expected);
      reopened.close();
    }
  });
});

describe('the run log', () => {
  function record(over: Partial<RunRecord> = {}): RunRecord {
    return {
      prId: 'o/r#1', headSha: 'aaa', phase: 'prepare', model: 'claude-x',
      startedAt: '2026-09-07T09:00:00.000Z', endedAt: '2026-09-07T09:08:00.000Z',
      durationMs: 480_000, turns: 12, costUsd: 1.2, inputTokens: 30, outputTokens: 27_000,
      cacheReadTokens: 1_100_000, cacheWriteTokens: 76_000, outcome: 'prepared', note: null, ...over,
    };
  }

  it('keeps a run whole and lists them newest first', () => {
    const store = new InboxStore(path);
    store.recordRun(record());
    store.recordRun(record({ phase: 'answer', outcome: 'answered', startedAt: '2026-09-07T10:00:00.000Z', endedAt: '2026-09-07T10:01:00.000Z' }));

    const rows = store.runs();
    expect(rows.map(row => row.phase)).toEqual(['answer', 'prepare']);
    expect(rows[1]).toEqual({ id: 1, ...record() });
    store.close();
  });

  it('lists one pull request, or one window, at a time', () => {
    const store = new InboxStore(path);
    store.recordRun(record({ startedAt: '2026-09-01T09:00:00.000Z' }));
    store.recordRun(record({ prId: 'o/r#2', startedAt: '2026-09-07T09:00:00.000Z' }));

    expect(store.runs({ prId: 'o/r#2' }).map(row => row.prId)).toEqual(['o/r#2']);
    expect(store.runs({ since: '2026-09-05T00:00:00.000Z' }).map(row => row.prId)).toEqual(['o/r#2']);
    expect(store.runs({ since: '2026-09-05T00:00:00.000Z', prId: 'o/r#1' })).toEqual([]);
    store.close();
  });

  it('adds up the minutes and the costs it knows, from the window given', () => {
    const store = new InboxStore(path);
    store.recordRun(record({ durationMs: 480_000, costUsd: 1.2 }));
    store.recordRun(record({ durationMs: 120_000, costUsd: null }));
    store.recordRun(record({ startedAt: '2026-08-01T09:00:00.000Z', durationMs: 600_000, costUsd: 9 }));

    expect(store.runTotals('2026-09-01T00:00:00.000Z')).toEqual({ count: 2, minutes: 10, costUsd: 1.2 });
    expect(store.runTotals('2026-09-08T00:00:00.000Z')).toEqual({ count: 0, minutes: 0, costUsd: 0 });
    store.close();
  });

  it('finds the runs behind one prepared head, oldest first', () => {
    const store = new InboxStore(path);
    store.recordRun(record({ phase: 'prepare' }));
    store.recordRun(record({ phase: 'answer', outcome: 'answered', startedAt: '2026-09-07T10:00:00.000Z' }));
    store.recordRun(record({ headSha: 'bbb', startedAt: '2026-09-07T11:00:00.000Z' }));

    expect(store.latestRunsFor('o/r#1', 'aaa').map(row => row.phase)).toEqual(['prepare', 'answer']);
    expect(store.latestRunsFor('o/r#1', 'ccc')).toEqual([]);
    store.close();
  });
});

describe('runRecordOf', () => {
  function stats(over: Partial<RunStats> = {}): RunStats {
    return {
      costUsd: 1.2, durationMs: 480_000, turns: 12, inputTokens: 30, outputTokens: 27_000,
      cacheReadTokens: 1_100_000, cacheWriteTokens: 76_000, models: ['claude-x'], isError: false,
      subtype: 'success', ...over,
    };
  }

  const shape = {
    prId: 'o/r#1', headSha: 'aaa', phase: 'prepare' as const, outcome: 'prepared' as const,
    startedAt: '2026-09-07T09:00:00.000Z', endedAt: '2026-09-07T09:10:00.000Z', configModel: 'opus',
  };

  it('takes the models and the duration the run reported', () => {
    expect(runRecordOf({ ...shape, stats: stats({ models: ['claude-x', 'claude-haiku'] }) }))
      .toMatchObject({ model: 'claude-x,claude-haiku', durationMs: 480_000, turns: 12, costUsd: 1.2, outputTokens: 27_000 });
  });

  it('falls back to the configured model and to the wall clock the daemon measured', () => {
    expect(runRecordOf({ ...shape, stats: stats({ models: [], durationMs: null }) }))
      .toMatchObject({ model: 'opus', durationMs: 600_000 });
    expect(runRecordOf({ ...shape, stats: null }))
      .toMatchObject({ model: 'opus', durationMs: 600_000, turns: null, costUsd: null, outputTokens: null });
    expect(runRecordOf({ ...shape, stats: null, configModel: null }).model).toBeNull();
  });
});

describe('the preparing pause', () => {
  it('reads back a moment still ahead, and not one already past', () => {
    const store = new InboxStore(path);
    expect(store.pausedUntil('2026-09-07T12:00:00.000Z')).toBeNull();

    store.pauseUntil('2026-09-07T14:00:00.000Z');
    expect(store.pausedUntil('2026-09-07T12:00:00.000Z')).toBe('2026-09-07T14:00:00.000Z');
    expect(store.pausedUntil('2026-09-07T14:00:01.000Z')).toBeNull();

    store.pauseUntil('2026-09-07T15:00:00.000Z');
    expect(store.pausedUntil('2026-09-07T14:30:00.000Z')).toBe('2026-09-07T15:00:00.000Z');
    store.pauseUntil(null);
    expect(store.pausedUntil('2026-09-07T14:30:00.000Z')).toBeNull();
    store.close();
  });
});

describe('the triage log', () => {
  it('keeps one decision per pull request, overwritten as the pull request moves', () => {
    const store = new InboxStore(path);
    expect(store.triageOf('o/r#1')).toBeNull();

    store.recordTriage({
      prId: 'o/r#1', updatedAt: '2026-09-02T10:00:00Z', headSha: null, outcome: 'none',
      reason: null, at: '2026-09-02T12:00:00.000Z',
    });
    expect(store.triageOf('o/r#1')).toEqual({
      prId: 'o/r#1', updatedAt: '2026-09-02T10:00:00Z', headSha: null, outcome: 'none',
      reason: null, at: '2026-09-02T12:00:00.000Z',
    });

    store.recordTriage({
      prId: 'o/r#1', updatedAt: '2026-09-02T11:00:00Z', headSha: 'bbb', outcome: 'alert',
      reason: 'risk level: high', at: '2026-09-02T13:00:00.000Z',
    });
    expect(store.triageOf('o/r#1')).toMatchObject({
      updatedAt: '2026-09-02T11:00:00Z', headSha: 'bbb', outcome: 'alert', reason: 'risk level: high',
    });

    // A look that reached no verdict is kept as such, with what went wrong as its reason.
    store.recordTriage({
      prId: 'o/r#1', updatedAt: '2026-09-02T11:00:00Z', headSha: null, outcome: 'failed',
      reason: 'the triage agent hit the Claude session limit', at: '2026-09-02T14:00:00.000Z',
    });
    expect(store.triageOf('o/r#1')).toMatchObject({
      outcome: 'failed', reason: 'the triage agent hit the Claude session limit', headSha: null,
    });
    store.close();
  });

  it('reads an outcome a later build stopped writing as one nothing was made of', () => {
    const store = new InboxStore(path);
    store.recordTriage({ prId: 'o/r#1', updatedAt: 'u', headSha: null, outcome: 'wat' as 'none', reason: null, at: 'now' });
    expect(store.triageOf('o/r#1')!.outcome).toBe('none');
    store.close();
  });

  it('keeps why a row was flagged, and hands it back with the row', () => {
    const store = new InboxStore(path);
    const pr = store.observe(snapshot(), false, 'now');
    expect(pr.triageReason).toBeNull();

    store.setTriageReason(pr.id, 'risk level: high');
    expect(store.get(pr.id)!.triageReason).toBe('risk level: high');
    // The forge's own word on the pull request leaves the reason alone.
    expect(store.observe({ ...snapshot(), headSha: 'bbb' }, false, 'later').triageReason).toBe('risk level: high');

    store.setTriageReason(pr.id, null);
    expect(store.get(pr.id)!.triageReason).toBeNull();
    store.close();
  });

  it('adds the reason column to a table created before it existed', () => {
    const seed = new DatabaseSync(path);
    seed.exec(`CREATE TABLE inbox_prs (
      id TEXT PRIMARY KEY, owner TEXT NOT NULL, repo TEXT NOT NULL, number INTEGER NOT NULL,
      title TEXT NOT NULL, url TEXT NOT NULL, author TEXT NOT NULL, is_draft INTEGER NOT NULL,
      head_sha TEXT NOT NULL, base_ref TEXT NOT NULL, additions INTEGER NOT NULL, deletions INTEGER NOT NULL,
      changed_files INTEGER NOT NULL, requested INTEGER NOT NULL, status TEXT NOT NULL, status_reason TEXT,
      attempts INTEGER NOT NULL DEFAULT 0, prepared_head_sha TEXT, prepared_at TEXT, bundle_path TEXT,
      worktree_path TEXT, log_path TEXT, first_seen_at TEXT NOT NULL, last_seen_at TEXT NOT NULL)`);
    seed.exec(`INSERT INTO inbox_prs (id, owner, repo, number, title, url, author, is_draft, head_sha, base_ref,
      additions, deletions, changed_files, requested, status, first_seen_at, last_seen_at)
      VALUES ('o/r#1', 'o', 'r', 1, 'T', 'u', 'alice', 0, 'aaa', 'main', 1, 0, 1, 1, 'queued', 'x', 'y')`);
    seed.close();

    const store = new InboxStore(path);
    expect(store.get('o/r#1')!.triageReason).toBeNull();
    store.setTriageReason('o/r#1', 'risk level: high');
    expect(store.get('o/r#1')!.triageReason).toBe('risk level: high');
    store.close();
  });

  it('remembers how the last pass went, and nothing before one has run', () => {
    const store = new InboxStore(path);
    expect(store.triagePass()).toBeNull();

    store.recordTriagePass({ watched: 12, quiet: 11, at: '2026-09-02T12:00:00.000Z' });
    expect(store.triagePass()).toEqual({ watched: 12, quiet: 11, at: '2026-09-02T12:00:00.000Z' });

    store.recordTriagePass({ watched: 13, quiet: 13, at: '2026-09-02T12:05:00.000Z' });
    expect(store.triagePass()).toEqual({ watched: 13, quiet: 13, at: '2026-09-02T12:05:00.000Z' });
    store.close();
  });

  it('reads a pass a previous build wrote in another shape as no pass at all', () => {
    const store = new InboxStore(path);
    store.recordTriagePass({ watched: 1, quiet: 1, at: 'now' });
    store.close();

    const seed = new DatabaseSync(path);
    seed.prepare("UPDATE inbox_state SET value = 'not json' WHERE key = 'triagePass'").run();
    seed.close();
    const reopened = new InboxStore(path);
    expect(reopened.triagePass()).toBeNull();
    reopened.close();
  });

  it('logs a triage run under its own phase', () => {
    const store = new InboxStore(path);
    store.recordRun(runRecordOf({
      prId: 'o/r#9', headSha: 'aaa', phase: 'triage', outcome: 'triaged',
      startedAt: '2026-09-07T09:00:00.000Z', endedAt: '2026-09-07T09:00:20.000Z',
      stats: null, configModel: 'haiku',
    }));
    expect(store.runs()).toMatchObject([{ phase: 'triage', outcome: 'triaged', model: 'haiku', durationMs: 20_000 }]);
    store.close();
  });
});
