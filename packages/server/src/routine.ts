import type { Db } from './db.js';
import type { Live } from './live.js';
import type { ReviewSessionRecord } from './reviews.js';
import type { Users } from './users.js';

export const ROUTINE_COOLDOWN_MS = 10 * 60 * 1000;
const FIRE_TIMEOUT_MS = 10_000;

export type RoutineFireKind = 'review' | 'ask';
export type RoutineFireResult = 'fired' | 'cooldown' | 'unconfigured' | 'failed';

/** Calls the user's Claude routine (an API trigger) to attend a session; the run itself happens elsewhere. */
export class Routine {
  constructor(
    private readonly db: Db,
    private readonly users: Users,
    private readonly live: Live,
    private readonly publicUrl: URL,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async configured(userId: string): Promise<boolean> {
    const settings = await this.users.routineSettings(userId);
    return !!settings.url && settings.keySet;
  }

  /** Fires the user's routine for the session unless none is configured or one fired within the cooldown; never throws. */
  async fire(userId: string, session: ReviewSessionRecord, kind: RoutineFireKind, now = Date.now()): Promise<RoutineFireResult> {
    try {
      const routine = await this.users.routine(userId);
      if (!routine) {
        return 'unconfigured';
      }
      const claimed = await this.db.one(
        `UPDATE sessions SET routine_fired_at = $3 WHERE id = $1 AND user_id = $2
            AND (routine_fired_at IS NULL OR routine_fired_at <= $4) RETURNING id`,
        [session.id, userId, now, now - ROUTINE_COOLDOWN_MS],
      );
      if (!claimed) {
        return 'cooldown';
      }
      const failure = await this.post(routine, userId, session, kind);
      if (failure === null) {
        return 'fired';
      }
      console.error(`routine fire failed for session ${session.id}: ${failure}`);
      await this.db.query('UPDATE sessions SET routine_fired_at = NULL WHERE id = $1 AND routine_fired_at = $2', [session.id, now]);
      return 'failed';
    } catch (err) {
      console.error(`routine fire failed for session ${session.id}: ${err instanceof Error ? err.message : String(err)}`);
      return 'failed';
    }
  }

  /** Null when the routine took the call, else why not. */
  private async post(routine: { url: string; key: string }, userId: string, session: ReviewSessionRecord, kind: RoutineFireKind): Promise<string | null> {
    const { token } = await this.live.issueSessionToken(userId, session.id);
    const text = [
      'diffity session', session.id,
      'repo', `${session.owner}/${session.repo}`,
      'pr', session.prNumber ?? '-',
      'base', session.baseSha,
      'head', session.headSha,
      'kind', kind,
      'url', new URL(`/s/${session.id}/`, this.publicUrl).href,
      'token', token,
    ].join(' ');
    try {
      const res = await this.fetchImpl(routine.url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${routine.key}`,
          'anthropic-beta': 'experimental-cc-routine-2026-04-01',
          'anthropic-version': '2023-06-01',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ text }),
        signal: AbortSignal.timeout(FIRE_TIMEOUT_MS),
      });
      return res.ok ? null : String(res.status);
    } catch (err) {
      return err instanceof Error ? err.message : String(err);
    }
  }
}
