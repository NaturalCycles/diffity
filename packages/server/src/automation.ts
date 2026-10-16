import type { Db } from './db.js';
import { randomToken, sha256 } from './crypto.js';
import { ServiceError } from './service.js';

/** Recognisable in a secret store or a leaked log, and cheap to tell from an OAuth token. */
export const AUTOMATION_TOKEN_PREFIX = 'dfa_';
const LAST_USED_RESOLUTION_MS = 60 * 1000;

export interface AutomationTokenInfo {
  name: string;
  createdAt: string;
  lastUsedAt: string | null;
}

/**
 * Bearer tokens for agents that cannot do OAuth, such as a scheduled routine: they act as the user
 * who minted them, with every MCP tool, until revoked. Only their hash is stored.
 */
export class AutomationTokens {
  constructor(private readonly db: Db) {}

  async mint(userId: string, name: string, now = Date.now()): Promise<string> {
    const token = `${AUTOMATION_TOKEN_PREFIX}${randomToken()}`;
    const inserted = await this.db.one(
      `INSERT INTO automation_tokens (token_hash, user_id, name, created_at) VALUES ($1, $2, $3, $4)
       ON CONFLICT (user_id, name) DO NOTHING RETURNING token_hash`,
      [sha256(token), userId, name, new Date(now).toISOString()],
    );
    if (!inserted) {
      throw new ServiceError(`You already have an automation token named "${name}"; revoke it first or pick another name`);
    }
    return token;
  }

  async list(userId: string): Promise<AutomationTokenInfo[]> {
    const rows = await this.db.query<{ name: string; created_at: string; last_used_at: string | null }>(
      'SELECT name, created_at, last_used_at FROM automation_tokens WHERE user_id = $1 ORDER BY created_at, name',
      [userId],
    );
    return rows.map(row => ({ name: row.name, createdAt: row.created_at, lastUsedAt: row.last_used_at }));
  }

  async revoke(userId: string, name: string): Promise<boolean> {
    const rows = await this.db.query('DELETE FROM automation_tokens WHERE user_id = $1 AND name = $2 RETURNING name', [userId, name]);
    return rows.length > 0;
  }

  /** Null for anything that is not a live automation token, including every OAuth token. */
  async verify(token: string, now = Date.now()): Promise<{ userId: string; name: string } | null> {
    if (!token.startsWith(AUTOMATION_TOKEN_PREFIX)) {
      return null;
    }
    const hash = sha256(token);
    const row = await this.db.one<{ user_id: string; name: string; last_used_at: string | null }>(
      'SELECT user_id, name, last_used_at FROM automation_tokens WHERE token_hash = $1',
      [hash],
    );
    if (!row) {
      return null;
    }
    if (!row.last_used_at || Date.parse(row.last_used_at) + LAST_USED_RESOLUTION_MS <= now) {
      await this.db.query('UPDATE automation_tokens SET last_used_at = $1 WHERE token_hash = $2', [new Date(now).toISOString(), hash]);
    }
    return { userId: row.user_id, name: row.name };
  }
}
