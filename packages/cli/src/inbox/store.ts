import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { ciState, type CiState, type PrSnapshot } from '@diffity/github';
import type { RunStats } from './agent-output.js';

export const INBOX_STATUSES = [
  'queued',
  'preparing',
  'prepared',
  'stale',
  'skipped',
  'failed',
  'draft',
  'hidden',
  'dismissed',
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
  /** What CI said about the current head at the last poll; null on a row from before it was kept. */
  ciState: CiState | null;
  /** The forge's own timestamps for the pull request; null on a row from before they were kept. */
  createdAt: string | null;
  updatedAt: string | null;
  /** Whether the last poll still listed it as awaiting the reviewer. */
  requested: boolean;
  status: InboxStatus;
  statusReason: string | null;
  /** How many times preparation has failed at the current head, reset when the head moves. */
  attempts: number;
  /** When the reviewer asked for this one now — at once, past the cap, the skips set aside. */
  bumpedAt: string | null;
  /** The head the prepared review is for; older than headSha means the review is stale. */
  preparedHeadSha: string | null;
  preparedAt: string | null;
  summary: string | null;
  alert: string | null;
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
  /** The findings by severity, as the page shows them: "1 P1 · 2 P2". */
  summary: string | null;
  /** Why the agent judged this one to need the reviewer now, when it did. */
  alert: string | null;
}

/** Which agent pass a run was: the drafting one, the one that checks its findings, or an answer. */
export const RUN_PHASES = ['prepare', 'validate', 'answer'] as const;
export type RunPhase = (typeof RUN_PHASES)[number];

export const RUN_OUTCOMES = ['prepared', 'skipped', 'validated', 'answered', 'failed', 'timeout', 'rate-limited'] as const;
export type RunOutcome = (typeof RUN_OUTCOMES)[number];

/** One agent run as the log keeps it: what it was for, what it spent, and how it ended. */
export interface RunRecord {
  prId: string;
  /** The head the run was about; null when the run was not tied to one. */
  headSha: string | null;
  phase: RunPhase;
  /** The models the run actually used, comma-separated, or the one the config asked for. */
  model: string | null;
  startedAt: string;
  endedAt: string;
  durationMs: number | null;
  turns: number | null;
  costUsd: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  cacheReadTokens: number | null;
  cacheWriteTokens: number | null;
  outcome: RunOutcome;
  /** Why it ended as it did, when there is more to say than the outcome. */
  note: string | null;
}

export interface RunRow extends RunRecord {
  id: number;
}

export interface RunTotals {
  count: number;
  minutes: number;
  costUsd: number;
}

/**
 * A run as the log wants it, from what the agent reported. `--output-format json` gives the run's
 * own duration; without it the wall clock the daemon measured stands in, and the model is the one
 * the config asked for rather than the one that answered.
 */
export function runRecordOf(input: {
  prId: string;
  headSha: string | null;
  phase: RunPhase;
  outcome: RunOutcome;
  startedAt: string;
  endedAt: string;
  stats: RunStats | null;
  /** `agent.model`, used when the run did not say which models it spent on. */
  configModel: string | null;
  note?: string | null;
}): RunRecord {
  const { stats } = input;
  const models = stats?.models.length ? stats.models.join(',') : null;
  return {
    prId: input.prId,
    headSha: input.headSha,
    phase: input.phase,
    model: models ?? input.configModel ?? null,
    startedAt: input.startedAt,
    endedAt: input.endedAt,
    durationMs: stats?.durationMs ?? elapsedMs(input.startedAt, input.endedAt),
    turns: stats?.turns ?? null,
    costUsd: stats?.costUsd ?? null,
    inputTokens: stats?.inputTokens ?? null,
    outputTokens: stats?.outputTokens ?? null,
    cacheReadTokens: stats?.cacheReadTokens ?? null,
    cacheWriteTokens: stats?.cacheWriteTokens ?? null,
    outcome: input.outcome,
    note: input.note ?? null,
  };
}

function elapsedMs(startedAt: string, endedAt: string): number | null {
  const from = Date.parse(startedAt);
  const to = Date.parse(endedAt);
  return Number.isFinite(from) && Number.isFinite(to) ? Math.max(0, to - from) : null;
}

export function prId(ref: { owner: string; repo: string; number: number }): string {
  return `${ref.owner}/${ref.repo}#${ref.number}`;
}

/**
 * Statuses the inbox is finished with: no poll re-queues them and no surface lists them. A
 * dismissal is not one — it stays listed so the reviewer can take it back with a bump.
 */
export function isRetired(status: InboxStatus): boolean {
  return status === 'done' || status === 'hidden';
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
        last_seen_at TEXT NOT NULL,
        created_at TEXT,
        updated_at TEXT,
        bumped_at TEXT,
        summary TEXT,
        alert TEXT,
        ci_state TEXT
      )
    `);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS inbox_runs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        pr_id TEXT NOT NULL,
        head_sha TEXT,
        phase TEXT NOT NULL,
        model TEXT,
        started_at TEXT NOT NULL,
        ended_at TEXT NOT NULL,
        duration_ms INTEGER,
        turns INTEGER,
        cost_usd REAL,
        input_tokens INTEGER,
        output_tokens INTEGER,
        cache_read_tokens INTEGER,
        cache_write_tokens INTEGER,
        outcome TEXT NOT NULL,
        note TEXT
      )
    `);
    this.db.exec('CREATE INDEX IF NOT EXISTS inbox_runs_pr_started ON inbox_runs (pr_id, started_at)');
    this.db.exec('CREATE TABLE IF NOT EXISTS inbox_state (key TEXT PRIMARY KEY, value TEXT)');
    // A table from an earlier build gains the columns it lacks; a fresh one already has them.
    for (const column of ['attempts INTEGER NOT NULL DEFAULT 0', 'created_at TEXT', 'updated_at TEXT', 'bumped_at TEXT', 'summary TEXT', 'alert TEXT', 'ci_state TEXT']) {
      try {
        this.db.exec(`ALTER TABLE inbox_prs ADD COLUMN ${column}`);
      } catch (err) {
        // "duplicate column" means it is already there; anything else is a real problem.
        if (!/duplicate column/i.test(err instanceof Error ? err.message : String(err))) {
          throw err;
        }
      }
    }
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
        additions, deletions, changed_files, requested, status, status_reason, first_seen_at, last_seen_at,
        created_at, updated_at, ci_state
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', NULL, ?, ?, ?, ?, ?)
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
        last_seen_at = excluded.last_seen_at,
        created_at = excluded.created_at,
        updated_at = excluded.updated_at,
        ci_state = excluded.ci_state
    `).run(
      id, snapshot.owner, snapshot.repo, snapshot.number, snapshot.title, snapshot.url, snapshot.author,
      snapshot.isDraft ? 1 : 0, snapshot.headSha, snapshot.baseRef,
      snapshot.additions, snapshot.deletions, snapshot.changedFiles, requested ? 1 : 0, now, now,
      snapshot.createdAt || null, snapshot.updatedAt || null, ciState(snapshot.checks),
    );
    return this.get(id)!;
  }

  setStatus(id: string, status: InboxStatus, reason: string | null = null): void {
    this.db.prepare('UPDATE inbox_prs SET status = ?, status_reason = ? WHERE id = ?').run(status, reason, id);
  }

  /** The reviewer wants this one prepared next, whatever verdict it had and however full the pile is. */
  bump(id: string, now: string): void {
    this.db.prepare("UPDATE inbox_prs SET status = 'queued', status_reason = 'bumped by the reviewer', bumped_at = ? WHERE id = ?").run(now, id);
  }

  /** The bump is spent once a preparation for it has run, whatever it came to. */
  clearBump(id: string): void {
    this.db.prepare('UPDATE inbox_prs SET bumped_at = NULL WHERE id = ?').run(id);
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
          bundle_path = ?, worktree_path = ?, log_path = ?, summary = ?, alert = ?
      WHERE id = ?
    `).run(prepared.headSha, prepared.at, prepared.bundlePath, prepared.worktreePath, prepared.logPath, prepared.summary, prepared.alert, id);
  }

  recordRun(run: RunRecord): void {
    this.db.prepare(`
      INSERT INTO inbox_runs (
        pr_id, head_sha, phase, model, started_at, ended_at, duration_ms, turns, cost_usd,
        input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, outcome, note
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      run.prId, run.headSha, run.phase, run.model, run.startedAt, run.endedAt, run.durationMs,
      run.turns, run.costUsd, run.inputTokens, run.outputTokens, run.cacheReadTokens,
      run.cacheWriteTokens, run.outcome, run.note,
    );
  }

  /** The run log, newest first. */
  runs(opts: { since?: string; prId?: string } = {}): RunRow[] {
    const where: string[] = [];
    const params: string[] = [];
    if (opts.since) {
      where.push('started_at >= ?');
      params.push(opts.since);
    }
    if (opts.prId) {
      where.push('pr_id = ?');
      params.push(opts.prId);
    }
    const sql = `SELECT * FROM inbox_runs${where.length ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY started_at DESC, id DESC`;
    return (this.db.prepare(sql).all(...params) as unknown as RunDbRow[]).map(rowToRun);
  }

  /** What the agent has spent since a moment; a run whose cost went unreported adds nothing to it. */
  runTotals(since: string): RunTotals {
    const row = this.db.prepare(
      'SELECT COUNT(*) AS count, SUM(duration_ms) AS ms, SUM(cost_usd) AS cost FROM inbox_runs WHERE started_at >= ?',
    ).get(since) as unknown as { count: number; ms: number | null; cost: number | null };
    return { count: row.count, minutes: round1((row.ms ?? 0) / 60_000), costUsd: row.cost ?? 0 };
  }

  /** The runs behind one prepared review — every pass made at that head, oldest first. */
  latestRunsFor(prId: string, headSha: string): RunRow[] {
    return (this.db.prepare('SELECT * FROM inbox_runs WHERE pr_id = ? AND head_sha = ? ORDER BY started_at ASC, id ASC')
      .all(prId, headSha) as unknown as RunDbRow[]).map(rowToRun);
  }

  /** Holds preparation back until a moment, or lifts the hold when given null. */
  pauseUntil(until: string | null): void {
    if (until === null) {
      this.db.prepare("DELETE FROM inbox_state WHERE key = 'pausedUntil'").run();
      return;
    }
    this.db.prepare("INSERT INTO inbox_state (key, value) VALUES ('pausedUntil', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(until);
  }

  /** Until when preparation is held back, or null when it is not — a moment already past is not one. */
  pausedUntil(now: string): string | null {
    const row = this.db.prepare("SELECT value FROM inbox_state WHERE key = 'pausedUntil'").get() as unknown as { value: string } | undefined;
    return row && row.value > now ? row.value : null;
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
  created_at: string | null;
  updated_at: string | null;
  bumped_at: string | null;
  summary: string | null;
  alert: string | null;
  ci_state: string | null;
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
    ciState: normaliseCiState(row.ci_state),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    requested: row.requested === 1,
    status: normaliseStatus(row.status),
    statusReason: row.status_reason,
    attempts: row.attempts,
    bumpedAt: row.bumped_at,
    preparedHeadSha: row.prepared_head_sha,
    preparedAt: row.prepared_at,
    summary: row.summary,
    alert: row.alert,
    bundlePath: row.bundle_path,
    worktreePath: row.worktree_path,
    logPath: row.log_path,
    firstSeenAt: row.first_seen_at,
    lastSeenAt: row.last_seen_at,
  };
}

interface RunDbRow {
  id: number;
  pr_id: string;
  head_sha: string | null;
  phase: string;
  model: string | null;
  started_at: string;
  ended_at: string;
  duration_ms: number | null;
  turns: number | null;
  cost_usd: number | null;
  input_tokens: number | null;
  output_tokens: number | null;
  cache_read_tokens: number | null;
  cache_write_tokens: number | null;
  outcome: string;
  note: string | null;
}

function rowToRun(row: RunDbRow): RunRow {
  return {
    id: row.id,
    prId: row.pr_id,
    headSha: row.head_sha,
    phase: row.phase as RunPhase,
    model: row.model,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    durationMs: row.duration_ms,
    turns: row.turns,
    costUsd: row.cost_usd,
    inputTokens: row.input_tokens,
    outputTokens: row.output_tokens,
    cacheReadTokens: row.cache_read_tokens,
    cacheWriteTokens: row.cache_write_tokens,
    outcome: row.outcome as RunOutcome,
    note: row.note,
  };
}

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

const CI_STATES: readonly string[] = ['passing', 'failing', 'running', 'none'];

function normaliseCiState(value: string | null): CiState | null {
  return value !== null && CI_STATES.includes(value) ? (value as CiState) : null;
}

/** A row from a build that knew other statuses is shown as needing work rather than crashing the list. */
function normaliseStatus(value: string): InboxStatus {
  return (INBOX_STATUSES as readonly string[]).includes(value) ? (value as InboxStatus) : 'queued';
}
