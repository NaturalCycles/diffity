import { randomUUID } from 'node:crypto';
import type { Db } from './db.js';
import { randomToken, sha256 } from './crypto.js';

export const LIVE_TOKEN_TTL_MS = 12 * 60 * 60 * 1000;
/** A request whose agent went quiet for this long is handed out again. */
export const CLAIM_TTL_MS = 10 * 60 * 1000;
/** Under the load balancer's 30 s backend timeout. */
export const MAX_WAIT_SECONDS = 25;
export const LISTENING_WINDOW_MS = 60 * 1000;

export interface LiveRequest {
  id: string;
  userId: string;
  sessionId: string;
  threadId: string;
  commentId: string;
  kind: 'ask';
  createdAt: string;
  claimedAt: number | null;
  claimExpiresAt: number | null;
  answeredAt: number | null;
}

interface LiveRequestRow {
  id: string;
  user_id: string;
  session_id: string;
  thread_id: string;
  comment_id: string;
  kind: 'ask';
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

/**
 * Questions a reader hands to the agent of a session, and the tokens that agent waits for them
 * with. The wake-up is in this process: the server runs as one instance.
 */
export class Live {
  private readonly waiters = new Map<string, Set<() => void>>();

  constructor(private readonly db: Db) {}

  /** The token grants waiting on this one session and nothing else; only its hash is kept. */
  async issueToken(userId: string, sessionId: string, now = Date.now()): Promise<{ token: string; expiresAt: number }> {
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

  /** The user the token waits for, when it is live and for exactly this session. */
  async verifyToken(token: string, sessionId: string, now = Date.now()): Promise<string | null> {
    const row = await this.db.one<{ user_id: string; session_id: string; expires_at: number }>(
      'SELECT user_id, session_id, expires_at FROM live_tokens WHERE token_hash = $1',
      [sha256(token)],
    );
    return row && row.session_id === sessionId && row.expires_at > now ? row.user_id : null;
  }

  async ask(userId: string, sessionId: string, threadId: string, commentId: string): Promise<void> {
    await this.db.query(
      `INSERT INTO live_requests (id, user_id, session_id, thread_id, comment_id, created_at)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [randomUUID(), userId, sessionId, threadId, commentId, new Date().toISOString()],
    );
    for (const wake of this.waiters.get(sessionId) ?? []) {
      wake();
    }
  }

  /** The oldest request nobody holds, now held by the caller until the claim expires. */
  async claim(userId: string, sessionId: string, now = Date.now()): Promise<LiveRequest | null> {
    const row = await this.db.one<LiveRequestRow>(
      `UPDATE live_requests SET claimed_at = $3, claim_expires_at = $4
        WHERE id = (
          SELECT id FROM live_requests
           WHERE user_id = $1 AND session_id = $2 AND answered_at IS NULL
             AND (claim_expires_at IS NULL OR claim_expires_at <= $3)
           ORDER BY seq ASC LIMIT 1
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

  /** Claims a request, waiting up to `waitMs` for one to be asked; null when none came or the caller left. */
  async next(userId: string, sessionId: string, waitMs: number, signal: AbortSignal): Promise<LiveRequest | null> {
    const deadline = Date.now() + waitMs;
    for (;;) {
      // Listening before claiming, so a request asked in between still wakes this wait.
      const woken = this.wakeup(sessionId, deadline - Date.now(), signal);
      const claimed = signal.aborted ? null : await this.claim(userId, sessionId);
      if (claimed || signal.aborted || Date.now() >= deadline) {
        woken.cancel();
        return claimed;
      }
      await woken.done;
    }
  }

  private wakeup(sessionId: string, ms: number, signal: AbortSignal): { done: Promise<void>; cancel: () => void } {
    let cancel = () => {};
    const done = new Promise<void>(resolve => {
      const waiters = this.waiters.get(sessionId) ?? new Set();
      this.waiters.set(sessionId, waiters);
      const finish = () => {
        clearTimeout(timer);
        signal.removeEventListener('abort', finish);
        waiters.delete(finish);
        if (waiters.size === 0) {
          this.waiters.delete(sessionId);
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

  async recordPoll(userId: string, sessionId: string, now = Date.now()): Promise<void> {
    await this.db.query('UPDATE sessions SET live_polled_at = $1 WHERE id = $2 AND user_id = $3', [now, sessionId, userId]);
  }

  async status(userId: string, sessionId: string, now = Date.now()): Promise<{ listening: boolean; lastPollAt: string | null }> {
    const row = await this.db.one<{ live_polled_at: number | null }>(
      'SELECT live_polled_at FROM sessions WHERE id = $1 AND user_id = $2',
      [sessionId, userId],
    );
    const polled = row?.live_polled_at ?? null;
    return {
      listening: polled !== null && now - polled < LISTENING_WINDOW_MS,
      lastPollAt: polled === null ? null : new Date(polled).toISOString(),
    };
  }

  async purgeExpired(now = Date.now()): Promise<void> {
    await this.db.query('DELETE FROM live_tokens WHERE expires_at < $1', [now]);
  }
}
