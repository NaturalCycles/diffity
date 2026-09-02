import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { InboxStore } from '../src/inbox/store.js';
import type { PrSnapshot } from '@diffity/github';

let dir: string;
let path: string;

function snapshot(): PrSnapshot {
  return {
    owner: 'o', repo: 'r', number: 1, title: 'T', url: 'https://github.com/o/r/pull/1',
    author: 'alice', isBot: false, isDraft: false, state: 'OPEN', headSha: 'aaa', baseRef: 'main',
    additions: 1, deletions: 0, changedFiles: 1, updatedAt: 'now',
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

  it('opens a fresh database and round-trips a prepared row', () => {
    const store = new InboxStore(path);
    store.observe(snapshot(), true, 'now');
    store.markPrepared('o/r#1', { headSha: 'aaa', bundlePath: '/b', worktreePath: '/wt', logPath: '/l', at: 'now' });
    const pr = store.get('o/r#1')!;
    expect(pr.status).toBe('prepared');
    expect(pr.preparedHeadSha).toBe('aaa');
    expect(pr.attempts).toBe(0);
    store.close();
  });
});
