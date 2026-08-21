import { getDb, queryOne } from './db.js';

export interface ReviewRun {
  inProgress: boolean;
  startedAt: string | null;
  note: string;
}

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
}
