import type { LiveRequest } from '@diffity/api';
import { getDb, queryOne } from './db.js';
import { normaliseSide } from './threads.js';
import { normaliseIntent, type LiveIntent } from './live-intent.js';

export type { LiveRequest } from '@diffity/api';

export interface LiveRequestStamp {
  /** Who should be woken for it. */
  sessionId: string | null;
  /** The stamp that was written, read back rather than guessed at by the caller. */
  requestedAt: string | null;
}

export function requestLive(commentId: string, intent: LiveIntent = 'ask'): LiveRequestStamp {
  getDb()
    .prepare("UPDATE comments SET live_requested_at = datetime('now'), live_intent = ? WHERE id = ?")
    .run(intent, commentId);

  const row = queryOne<{ session_id: string; live_requested_at: string | null }>(
    `SELECT t.session_id, c.live_requested_at FROM comments c JOIN comment_threads t ON t.id = c.thread_id
      WHERE c.id = ?`,
    commentId,
  );

  return { sessionId: row?.session_id ?? null, requestedAt: row?.live_requested_at ?? null };
}

/**
 * Takes the oldest request nobody has picked up, in one statement: two listeners on one session
 * must not both go and answer the same question.
 */
export function claimNextLiveRequest(sessionId: string): LiveRequest | null {
  const claimed = queryOne<{ id: string }>(
    `UPDATE comments SET live_claimed_at = datetime('now')
      WHERE id = (
        SELECT c.id FROM comments c
          JOIN comment_threads t ON t.id = c.thread_id
         WHERE t.session_id = ?
           AND c.live_requested_at IS NOT NULL
           AND c.live_claimed_at IS NULL
           AND c.live_answered_at IS NULL
         ORDER BY c.live_requested_at ASC, c.rowid ASC
         LIMIT 1
      )
      RETURNING id`,
    sessionId,
  );

  if (!claimed) {
    return null;
  }

  const request = queryOne<LiveRequest>(
    `SELECT c.id AS commentId, c.thread_id AS threadId, c.body AS body,
              c.author_name AS authorName, c.live_intent AS intent,
              t.file_path AS filePath, t.side AS side,
              t.start_line AS startLine, t.end_line AS endLine,
              (SELECT f.body FROM comments f WHERE f.thread_id = t.id
                 AND COALESCE(f.kind, 'review') = 'review'
                ORDER BY f.created_at ASC, f.rowid ASC LIMIT 1) AS findingBody
         FROM comments c JOIN comment_threads t ON t.id = c.thread_id
        WHERE c.id = ?`,
    claimed.id,
  );

  return request ? { ...request, side: normaliseSide(request.side), intent: normaliseIntent(request.intent) } : null;
}

/**
 * Takes a full id or the 8-char prefix the rest of the CLI takes, and says whether it matched. A
 * silent miss would leave the page saying an agent is working on something it has already answered.
 */
export function answerLiveRequest(commentIdOrPrefix: string): boolean {
  const result = getDb()
    .prepare("UPDATE comments SET live_answered_at = datetime('now') WHERE id = ? OR id LIKE ?")
    .run(commentIdOrPrefix, `${commentIdOrPrefix}%`);
  return Number(result.changes ?? 0) > 0;
}

/**
 * Requests an agent has taken and not yet answered. Between the two it is not parked on the claim
 * route, so presence alone would report nobody there while somebody is working on your question.
 */
export function liveWorkingCount(sessionId: string): number {
  const row = queryOne<{ n: number }>(
    `SELECT COUNT(*) AS n FROM comments c JOIN comment_threads t ON t.id = c.thread_id
      WHERE t.session_id = ?
        AND c.live_claimed_at IS NOT NULL
        AND c.live_answered_at IS NULL`,
    sessionId,
  );
  return row?.n ?? 0;
}

/** How many requests are waiting for somebody to pick them up. */
export function pendingLiveCount(sessionId: string): number {
  const row = queryOne<{ n: number }>(
    `SELECT COUNT(*) AS n FROM comments c JOIN comment_threads t ON t.id = c.thread_id
      WHERE t.session_id = ?
        AND c.live_requested_at IS NOT NULL
        AND c.live_claimed_at IS NULL
        AND c.live_answered_at IS NULL`,
    sessionId,
  );
  return row?.n ?? 0;
}

/**
 * An agent can be claimed and then go away — a crash, a closed terminal. Without this the request
 * would sit claimed forever and the thread would say the agent was working on it.
 */
export function reclaimStaleLiveRequests(olderThanMinutes: number): number {
  const result = getDb()
    .prepare(
      `UPDATE comments SET live_claimed_at = NULL
        WHERE live_requested_at IS NOT NULL
          AND live_claimed_at IS NOT NULL
          AND live_answered_at IS NULL
          AND live_claimed_at < datetime('now', ?)`,
    )
    .run(`-${olderThanMinutes} minutes`);
  return Number(result.changes ?? 0);
}

/**
 * Presence is a request parked on the claim route, not a row in the database. Nothing expires,
 * because the connection closing is what ends the wait — which only became true once something
 * listened for it: before that a dead listener stayed counted until its wait ran out.
 *
 * Kept per session rather than per process, because one server holds a whole checkout — the file
 * browser is its own session and each ref gets one. A single set would have every session claiming
 * an agent that is parked on one of them.
 */
const listeners = new Map<string, Set<() => void>>();

export function liveListenerCount(sessionId: string): number {
  return listeners.get(sessionId)?.size ?? 0;
}

/** Every parked listener on this instance, whichever session each one waits on. */
export function liveListenerTotal(): number {
  let total = 0;
  for (const forSession of listeners.values()) {
    total += forSession.size;
  }
  return total;
}

export function notifyLiveListeners(sessionId: string | null): void {
  if (!sessionId) {
    return;
  }
  for (const wake of [...(listeners.get(sessionId) ?? [])]) {
    wake();
  }
}

/**
 * Waits for something to be asked, up to `waitMs`. Resolves with null on timeout so the caller can
 * tell "nothing was asked" from "something went wrong" and re-arm.
 */
/**
 * `signal` is the listener's connection going away. Without it a listener that died stayed counted
 * until its wait ran out, and the page went on saying an agent was there for up to that long.
 */
export function waitForLiveRequest(
  sessionId: string,
  waitMs: number,
  signal?: AbortSignal,
): Promise<LiveRequest | null> {
  const claimed = claimNextLiveRequest(sessionId);
  if (claimed || waitMs <= 0 || signal?.aborted) {
    return Promise.resolve(claimed);
  }

  return new Promise(resolve => {
    let settled = false;
    const finish = (request: LiveRequest | null) => {
      if (settled) {
        return;
      }
      settled = true;
      const forSession = listeners.get(sessionId);
      forSession?.delete(wake);
      if (forSession?.size === 0) {
        listeners.delete(sessionId);
      }
      clearTimeout(timer);
      signal?.removeEventListener('abort', giveUp);
      resolve(request);
    };

    const giveUp = () => finish(null);

    // Only a request this listener could take ends its wait. Waking on anything else would end it
    // with "nothing asked" and send the agent round the loop for someone else's question.
    const wake = () => {
      const claimed = claimNextLiveRequest(sessionId);
      if (claimed) {
        finish(claimed);
      }
    };
    const timer = setTimeout(() => finish(null), waitMs);
    timer.unref?.();
    signal?.addEventListener('abort', giveUp, { once: true });

    const forSession = listeners.get(sessionId) ?? new Set<() => void>();
    forSession.add(wake);
    listeners.set(sessionId, forSession);
  });
}
