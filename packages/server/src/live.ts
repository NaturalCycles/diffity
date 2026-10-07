import { randomUUID } from 'node:crypto';
import type { Db } from './db.js';
import { randomToken, sha256 } from './crypto.js';

export const LIVE_TOKEN_TTL_MS = 12 * 60 * 60 * 1000;
/** A request whose agent went quiet for this long is handed out again. */
export const CLAIM_TTL_MS = 10 * 60 * 1000;
/** Under the load balancer's 30 s backend timeout. */
export const MAX_WAIT_SECONDS = 25;
export const LISTENING_WINDOW_MS = 60 * 1000;
/** How long a queued review may wait for an agent before the page stops expecting one. */
export const REVIEW_STALE_MS = 15 * 60 * 1000;

export type LiveRequestKind = 'ask' | 'review';

export interface LiveRequest {
  id: string;
  userId: string;
  sessionId: string;
  threadId: string | null;
  commentId: string | null;
  kind: LiveRequestKind;
  createdAt: string;
  claimedAt: number | null;
  claimExpiresAt: number | null;
  answeredAt: number | null;
}

interface LiveRequestRow {
  id: string;
  user_id: string;
  session_id: string;
  thread_id: string | null;
  comment_id: string | null;
  kind: LiveRequestKind;
  created_at: string;
  claimed_at: number | null;
  claim_expires_at: number | null;
  answered_at: number | null;
}

function rowToRequest(row: LiveRequestRow): LiveRequest {
  return {
    id: row.id,
    userId: row.user_id,
    sessionId: row.session_id,
    threadId: row.thread_id,
    commentId: row.comment_id,
    kind: row.kind,
    createdAt: row.created_at,
    claimedAt: row.claimed_at,
    claimExpiresAt: row.claim_expires_at,
    answeredAt: row.answered_at,
  };
}

/**
 * Plain curl and POSIX shell, since the agent may run where nothing of diffity is installed. It
 * exits only with a request (0) or a refused token (1); a 204 or a network error polls again.
 */
export function awaitCommand(token: string, pollUrl: string): string {
  return [
    `while :; do out=$(curl -s -m 60 -w '%{http_code}' -H 'Authorization: Bearer ${token}' '${pollUrl}');`,
    'code=${out#"${out%???}"};',
    'case $code in',
    `200) printf '%s\\n' "\${out%???}"; exit 0;;`,
    '401|403) echo "diffity: the live token was refused (HTTP $code); get a new one with live_token" >&2; exit 1;;',
    'esac; sleep 1; done',
  ].join(' ');
}

export interface LiveListener {
  userId: string;
  /** Null for a token that waits on everything of the user's. */
  sessionId: string | null;
}

export interface LiveStatus {
  listening: boolean;
  lastPollAt: string | null;
}

function liveStatus(polls: (number | null | undefined)[], now: number): LiveStatus {
  const latest = Math.max(...polls.map(poll => poll ?? -Infinity));
  return {
    listening: now - latest < LISTENING_WINDOW_MS,
    lastPollAt: Number.isFinite(latest) ? new Date(latest).toISOString() : null,
  };
}

const userKey = (userId: string) => `user:${userId}`;

/**
 * Questions and reviews handed to an agent, and the tokens it waits for them with: on one session,
 * or on the whole of the user's queue. The wake-up is in this process: the server runs as one
 * instance.
 */
export class Live {
  private readonly waiters = new Map<string, Set<() => void>>();

  constructor(private readonly db: Db) {}

  /**
   * A token grants waiting and nothing else: on this one session, or without one on any of the
   * user's. Only its hash is kept.
   */
  async issueToken(userId: string, sessionId: string | null, now = Date.now()): Promise<{ token: string; expiresAt: number }> {
    const token = randomToken();
    const expiresAt = now + LIVE_TOKEN_TTL_MS;
    await this.db.query('INSERT INTO live_tokens (token_hash, user_id, session_id, expires_at) VALUES ($1, $2, $3, $4)', [
      sha256(token),
      userId,
      sessionId,
      expiresAt,
    ]);
    return { token, expiresAt };
  }

  /**
   * Who may wait where with this token. Without a session only a user token qualifies; with one,
   * that session's token, or a user token when the session is the user's.
   */
  async verifyToken(token: string, sessionId: string | null, now = Date.now()): Promise<string | null> {
    const row = await this.db.one<{ user_id: string; session_id: string | null; expires_at: number }>(
      'SELECT user_id, session_id, expires_at FROM live_tokens WHERE token_hash = $1',
      [sha256(token)],
    );
    if (!row || row.expires_at <= now) {
      return null;
    }
    if (sessionId === null || row.session_id !== null) {
      return row.session_id === sessionId ? row.user_id : null;
    }
    const owned = await this.db.one('SELECT 1 FROM sessions WHERE id = $1 AND user_id = $2', [sessionId, row.user_id]);
    return owned ? row.user_id : null;
  }

  async ask(userId: string, sessionId: string, threadId: string, commentId: string): Promise<void> {
    await this.db.query(
      `INSERT INTO live_requests (id, user_id, session_id, thread_id, comment_id, created_at)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [randomUUID(), userId, sessionId, threadId, commentId, new Date().toISOString()],
    );
    this.wake(userId, sessionId);
  }

  /** Queues the session for an agent to review, unless a review of it is already waiting; true when queued now. */
  async queueReview(userId: string, sessionId: string): Promise<boolean> {
    const inserted = await this.db.one(
      `INSERT INTO live_requests (id, user_id, session_id, kind, created_at) VALUES ($1, $2, $3, 'review', $4)
       ON CONFLICT (session_id) WHERE kind = 'review' AND answered_at IS NULL DO NOTHING RETURNING id`,
      [randomUUID(), userId, sessionId, new Date().toISOString()],
    );
    if (inserted) {
      this.wake(userId, sessionId);
    }
    return inserted !== undefined;
  }

  private wake(userId: string, sessionId: string): void {
    for (const key of [sessionId, userKey(userId)]) {
      for (const wake of this.waiters.get(key) ?? []) {
        wake();
      }
    }
  }

  /**
   * The oldest request nobody holds, now held by the caller until the claim expires: a question on
   * the session, or anything across the user's. A review an agent has started is not handed out.
   */
  async claim(userId: string, sessionId: string | null, now = Date.now()): Promise<LiveRequest | null> {
    const row = await this.db.one<LiveRequestRow>(
      `UPDATE live_requests SET claimed_at = $3, claim_expires_at = $4
        WHERE id = (
          SELECT q.id FROM live_requests q
           WHERE q.user_id = $1 AND ($2::text IS NULL OR (q.session_id = $2 AND q.kind = 'ask')) AND q.answered_at IS NULL
             AND (q.claim_expires_at IS NULL OR q.claim_expires_at <= $3)
             AND NOT (q.kind = 'review' AND EXISTS (
               SELECT 1 FROM sessions s WHERE s.id = q.session_id AND s.review_started_at IS NOT NULL AND s.review_finished_at IS NULL))
           ORDER BY q.seq ASC LIMIT 1
           FOR UPDATE SKIP LOCKED)
        RETURNING *`,
      [userId, sessionId, now, now + CLAIM_TTL_MS],
    );
    return row ? rowToRequest(row) : null;
  }

  /** For a claim whose poller left before it could be told. */
  async release(requestId: string): Promise<void> {
    await this.db.query('UPDATE live_requests SET claimed_at = NULL, claim_expires_at = NULL WHERE id = $1 AND answered_at IS NULL', [requestId]);
  }

  /** Claims a request, waiting up to `waitMs` for one to come; null when none came or the caller left. */
  async next(listener: LiveListener, waitMs: number, signal: AbortSignal): Promise<LiveRequest | null> {
    const key = listener.sessionId ?? userKey(listener.userId);
    const deadline = Date.now() + waitMs;
    for (;;) {
      // Listening before claiming, so a request asked in between still wakes this wait.
      const woken = this.wakeup(key, deadline - Date.now(), signal);
      const claimed = signal.aborted ? null : await this.claim(listener.userId, listener.sessionId);
      if (claimed || signal.aborted || Date.now() >= deadline) {
        woken.cancel();
        return claimed;
      }
      await woken.done;
    }
  }

  private wakeup(key: string, ms: number, signal: AbortSignal): { done: Promise<void>; cancel: () => void } {
    let cancel = () => {};
    const done = new Promise<void>(resolve => {
      const waiters = this.waiters.get(key) ?? new Set();
      this.waiters.set(key, waiters);
      const finish = () => {
        clearTimeout(timer);
        signal.removeEventListener('abort', finish);
        waiters.delete(finish);
        if (waiters.size === 0) {
          this.waiters.delete(key);
        }
        resolve();
      };
      const timer = setTimeout(finish, Math.max(0, ms));
      signal.addEventListener('abort', finish);
      waiters.add(finish);
      cancel = finish;
    });
    return { done, cancel };
  }

  /** An agent's reply settles every question still open in the thread. */
  async answer(userId: string, threadId: string, now = Date.now()): Promise<void> {
    await this.db.query('UPDATE live_requests SET answered_at = $1 WHERE user_id = $2 AND thread_id = $3 AND answered_at IS NULL', [
      now,
      userId,
      threadId,
    ]);
  }

  /** The agent's review_done settles the review waiting on the session. */
  async answerReview(userId: string, sessionId: string, now = Date.now()): Promise<void> {
    await this.db.query(
      "UPDATE live_requests SET answered_at = $1 WHERE user_id = $2 AND session_id = $3 AND kind = 'review' AND answered_at IS NULL",
      [now, userId, sessionId],
    );
  }

  async recordPoll(listener: LiveListener, now = Date.now()): Promise<void> {
    if (listener.sessionId === null) {
      await this.db.query('UPDATE users SET live_polled_at = $1 WHERE id = $2', [now, listener.userId]);
      return;
    }
    await this.db.query('UPDATE sessions SET live_polled_at = $1 WHERE id = $2 AND user_id = $3', [now, listener.sessionId, listener.userId]);
  }

  /** An agent listens on a session when it waits on that session or on everything of the user's. */
  async status(userId: string, sessionId: string, now = Date.now()): Promise<LiveStatus> {
    const row = await this.db.one<{ session_poll: number | null; user_poll: number | null }>(
      `SELECT s.live_polled_at AS session_poll, u.live_polled_at AS user_poll
         FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.id = $1 AND s.user_id = $2`,
      [sessionId, userId],
    );
    return liveStatus([row?.session_poll, row?.user_poll], now);
  }

  /** Whether an agent waits on the user's whole queue, which is what a new session's review needs. */
  async userStatus(userId: string, now = Date.now()): Promise<LiveStatus> {
    const row = await this.db.one<{ live_polled_at: number | null }>('SELECT live_polled_at FROM users WHERE id = $1', [userId]);
    return liveStatus([row?.live_polled_at], now);
  }

  async purgeExpired(now = Date.now()): Promise<void> {
    await this.db.query('DELETE FROM live_tokens WHERE expires_at < $1', [now]);
  }
}
