import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { PrSnapshot } from '@diffity/github';

export const INBOX_STATUSES = [
  'queued',
  'preparing',
  'prepared',
  'stale',
  'skipped',
  'failed',
  'draft',
  'hidden',
  'done',
] as const;
export type InboxStatus = (typeof INBOX_STATUSES)[number];

/** One pull request as the inbox knows it: the forge's latest word on it, and what was done about it. */
export interface InboxPr {
  /** `owner/repo#number`. */
  id: string;
  owner: string;
  repo: string;
  number: number;
  title: string;
  url: string;
  author: string;
  isDraft: boolean;
  headSha: string;
  baseRef: string;
  additions: number;
  deletions: number;
  changedFiles: number;
  /** Whether the last poll still listed it as awaiting the reviewer. */
  requested: boolean;
  status: InboxStatus;
  statusReason: string | null;
  /** How many times preparation has failed at the current head, reset when the head moves. */
  attempts: number;
  /** The head the prepared review is for; older than headSha means the review is stale. */
  preparedHeadSha: string | null;
  preparedAt: string | null;
  bundlePath: string | null;
  worktreePath: string | null;
  logPath: string | null;
  firstSeenAt: string;
  lastSeenAt: string;
}

export interface Prepared {
  headSha: string;
  bundlePath: string;
  worktreePath: string;
  logPath: string;
  at: string;
}

export function prId(ref: { owner: string; repo: string; number: number }): string {
  return `${ref.owner}/${ref.repo}#${ref.number}`;
}

/**
 * The inbox's own database, apart from the review sessions': the daemon outlives any one
 * instance, and its rows answer to the forge, not to a checkout.
 */
export class InboxStore {
  private readonly db: DatabaseSync;

  constructor(path: string) {
    if (path !== ':memory:') {
      mkdirSync(dirname(path), { recursive: true });
    }
    this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA journal_mode = WAL');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS inbox_prs (
        id TEXT PRIMARY KEY,
        owner TEXT NOT NULL,
        repo TEXT NOT NULL,
        number INTEGER NOT NULL,
        title TEXT NOT NULL,
        url TEXT NOT NULL,
        author TEXT NOT NULL,
        is_draft INTEGER NOT NULL,
        head_sha TEXT NOT NULL,
        base_ref TEXT NOT NULL,
        additions INTEGER NOT NULL,
        deletions INTEGER NOT NULL,
        changed_files INTEGER NOT NULL,
        requested INTEGER NOT NULL,
        status TEXT NOT NULL,
        status_reason TEXT,
        attempts INTEGER NOT NULL DEFAULT 0,
        prepared_head_sha TEXT,
        prepared_at TEXT,
        bundle_path TEXT,
        worktree_path TEXT,
        log_path TEXT,
        first_seen_at TEXT NOT NULL,
        last_seen_at TEXT NOT NULL
      )
    `);
  }

  close(): void {
    this.db.close();
  }

  all(): InboxPr[] {
    return (this.db.prepare('SELECT * FROM inbox_prs ORDER BY first_seen_at ASC, id ASC').all() as unknown as Row[]).map(rowToPr);
  }

  get(id: string): InboxPr | null {
    const row = this.db.prepare('SELECT * FROM inbox_prs WHERE id = ?').get(id) as unknown as Row | undefined;
    return row ? rowToPr(row) : null;
  }

  /**
   * Records what the forge said, leaving the inbox's own columns alone: a new pull request starts
   * out `queued`, a known one keeps its status until `setStatus` decides otherwise.
   */
  observe(snapshot: PrSnapshot, requested: boolean, now: string): InboxPr {
    const id = prId(snapshot);
    this.db.prepare(`
      INSERT INTO inbox_prs (
        id, owner, repo, number, title, url, author, is_draft, head_sha, base_ref,
        additions, deletions, changed_files, requested, status, status_reason, first_seen_at, last_seen_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', NULL, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        title = excluded.title,
        url = excluded.url,
        author = excluded.author,
        is_draft = excluded.is_draft,
        -- A new head is a new change to review: the failed-attempt count for the old one is spent.
        attempts = CASE WHEN inbox_prs.head_sha = excluded.head_sha THEN inbox_prs.attempts ELSE 0 END,
        head_sha = excluded.head_sha,
        base_ref = excluded.base_ref,
        additions = excluded.additions,
        deletions = excluded.deletions,
        changed_files = excluded.changed_files,
        requested = excluded.requested,
        last_seen_at = excluded.last_seen_at
    `).run(
      id, snapshot.owner, snapshot.repo, snapshot.number, snapshot.title, snapshot.url, snapshot.author,
      snapshot.isDraft ? 1 : 0, snapshot.headSha, snapshot.baseRef,
      snapshot.additions, snapshot.deletions, snapshot.changedFiles, requested ? 1 : 0, now, now,
    );
    return this.get(id)!;
  }

  setStatus(id: string, status: InboxStatus, reason: string | null = null): void {
    this.db.prepare('UPDATE inbox_prs SET status = ?, status_reason = ? WHERE id = ?').run(status, reason, id);
  }

  /** Records a failed attempt at the current head; the count gates how many more are worth trying. */
  failAttempt(id: string, reason: string): void {
    this.db.prepare('UPDATE inbox_prs SET status = ?, status_reason = ?, attempts = attempts + 1 WHERE id = ?')
      .run('failed', reason, id);
  }

  markPrepared(id: string, prepared: Prepared): void {
    this.db.prepare(`
      UPDATE inbox_prs
      SET status = 'prepared', status_reason = NULL, prepared_head_sha = ?, prepared_at = ?,
          bundle_path = ?, worktree_path = ?, log_path = ?
      WHERE id = ?
    `).run(prepared.headSha, prepared.at, prepared.bundlePath, prepared.worktreePath, prepared.logPath, id);
  }

  /** Where the preparation left its trail, kept even when it ended in a skip or a failure. */
  setPaths(id: string, paths: { worktreePath?: string | null; logPath?: string | null }): void {
    if (paths.worktreePath !== undefined) {
      this.db.prepare('UPDATE inbox_prs SET worktree_path = ? WHERE id = ?').run(paths.worktreePath, id);
    }
    if (paths.logPath !== undefined) {
      this.db.prepare('UPDATE inbox_prs SET log_path = ? WHERE id = ?').run(paths.logPath, id);
    }
  }
}

interface Row {
  id: string;
  owner: string;
  repo: string;
  number: number;
  title: string;
  url: string;
  author: string;
  is_draft: number;
  head_sha: string;
  base_ref: string;
  additions: number;
  deletions: number;
  changed_files: number;
  requested: number;
  status: string;
  status_reason: string | null;
  attempts: number;
  prepared_head_sha: string | null;
  prepared_at: string | null;
  bundle_path: string | null;
  worktree_path: string | null;
  log_path: string | null;
  first_seen_at: string;
  last_seen_at: string;
}

function rowToPr(row: Row): InboxPr {
  return {
    id: row.id,
    owner: row.owner,
    repo: row.repo,
    number: row.number,
    title: row.title,
    url: row.url,
    author: row.author,
    isDraft: row.is_draft === 1,
    headSha: row.head_sha,
    baseRef: row.base_ref,
    additions: row.additions,
    deletions: row.deletions,
    changedFiles: row.changed_files,
    requested: row.requested === 1,
    status: normaliseStatus(row.status),
    statusReason: row.status_reason,
    attempts: row.attempts,
    preparedHeadSha: row.prepared_head_sha,
    preparedAt: row.prepared_at,
    bundlePath: row.bundle_path,
    worktreePath: row.worktree_path,
    logPath: row.log_path,
    firstSeenAt: row.first_seen_at,
    lastSeenAt: row.last_seen_at,
  };
}

/** A row from a build that knew other statuses is shown as needing work rather than crashing the list. */
function normaliseStatus(value: string): InboxStatus {
  return (INBOX_STATUSES as readonly string[]).includes(value) ? (value as InboxStatus) : 'queued';
}
