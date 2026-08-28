import type { ReviewRun } from '@diffity/api';
import { getDb, queryOne } from './db.js';

export type { ReviewRun } from '@diffity/api';

const ABSENT: ReviewRun = { inProgress: false, startedAt: null, note: '' };

/**
 * Whether an agent is part-way through writing findings. A reader who cannot tell the difference
 * between "no problems found" and "not finished looking" can approve a change too early.
 */
export function getReviewRun(sessionId: string): ReviewRun {
  const row = queryOne<{ started_at: string; finished_at: string | null; note: string }>(
    'SELECT started_at, finished_at, note FROM review_runs WHERE session_id = ?',
    sessionId,
  );

  if (!row) {
    return ABSENT;
  }

  return {
    inProgress: !row.finished_at,
    startedAt: row.started_at,
    note: row.note,
  };
}

export function startReviewRun(sessionId: string, note: string): void {
  getDb()
    .prepare(
      `INSERT INTO review_runs (session_id, started_at, finished_at, note)
       VALUES (?, datetime('now'), NULL, ?)
       ON CONFLICT(session_id) DO UPDATE SET
         started_at = datetime('now'),
         finished_at = NULL,
         note = excluded.note`,
    )
    .run(sessionId, note);
}

export function finishReviewRun(sessionId: string): void {
  getDb()
    .prepare("UPDATE review_runs SET finished_at = datetime('now') WHERE session_id = ?")
    .run(sessionId);
}

/** No real review writes findings this long without finishing or being superseded. */
const RUN_COUNTS_FOR_HOURS = 2;

/**
 * Whether any review of this checkout is still being written. The session an agent works on is
 * not the server's startup session — a tree review, or one carried forward by a commit — so the
 * question has to be asked repo-wide. Bounded by age, because a run abandoned by a crashed agent
 * has nobody left to finish it, and unbounded it would hold every future server open.
 */
export function anyReviewInProgress(repoRoot: string | null): boolean {
  const row = queryOne<{ n: number }>(
    `SELECT COUNT(*) AS n FROM review_runs r
       JOIN review_sessions s ON s.id = r.session_id
      WHERE s.repo_root IS ? AND r.finished_at IS NULL
        AND r.started_at > datetime('now', ?)`,
    repoRoot,
    `-${RUN_COUNTS_FOR_HOURS} hours`,
  );
  return (row?.n ?? 0) > 0;
}

/** An unfinished run follows the session, so committing mid-review does not clear the warning. */
export function carryReviewRun(fromSessionId: string, toSessionId: string): void {
  const run = queryOne<{ started_at: string; note: string }>(
    'SELECT started_at, note FROM review_runs WHERE session_id = ? AND finished_at IS NULL',
    fromSessionId,
  );

  if (!run) {
    return;
  }

  getDb()
    .prepare(
      `INSERT INTO review_runs (session_id, started_at, finished_at, note)
       VALUES (?, ?, NULL, ?)
       ON CONFLICT(session_id) DO UPDATE SET started_at = excluded.started_at, finished_at = NULL, note = excluded.note`,
    )
    .run(toSessionId, run.started_at, run.note);

  // The run has moved. Left behind, the donor's half-open row would say a review of this
  // checkout is in progress for as long as the database exists.
  getDb().prepare('DELETE FROM review_runs WHERE session_id = ?').run(fromSessionId);
}
