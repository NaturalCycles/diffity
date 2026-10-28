import { randomUUID } from 'node:crypto';
import type { Db } from './db.js';
import { decrypt, encrypt, randomToken, sha256 } from './crypto.js';

export interface User {
  id: string;
  email: string;
  name: string;
  githubLogin: string | null;
}

/** What the Sessions page lists of the pull requests waiting for the user's review. */
export interface UserSettings {
  /** A pull request whose title contains any of these, ignoring case, is not listed. */
  skipTitles: string[];
  includeDrafts: boolean;
}

interface UserRow {
  id: string;
  email: string;
  name: string;
  github_login: string | null;
}

function rowToUser(row: UserRow): User {
  return { id: row.id, email: row.email, name: row.name, githubLogin: row.github_login };
}

export class Users {
  constructor(private readonly db: Db, private readonly secretKey: Buffer) {}

  async findOrCreate(email: string, name?: string): Promise<User> {
    const normalised = email.trim().toLowerCase();
    const existing = await this.db.one<UserRow>('SELECT * FROM users WHERE email = $1', [normalised]);
    if (existing) {
      return rowToUser(existing);
    }
    await this.db.query(
      'INSERT INTO users (id, email, name, created_at) VALUES ($1, $2, $3, $4) ON CONFLICT (email) DO NOTHING',
      [randomUUID(), normalised, name?.trim() || normalised, new Date().toISOString()],
    );
    return rowToUser((await this.db.one<UserRow>('SELECT * FROM users WHERE email = $1', [normalised]))!);
  }

  async get(id: string): Promise<User | null> {
    const row = await this.db.one<UserRow>('SELECT * FROM users WHERE id = $1', [id]);
    return row ? rowToUser(row) : null;
  }

  async setGitHubToken(userId: string, token: string | null, login: string | null = null): Promise<void> {
    await this.db.query('UPDATE users SET github_token = $1, github_login = $2 WHERE id = $3', [
      token ? encrypt(this.secretKey, token) : null,
      token ? login : null,
      userId,
    ]);
  }

  async settings(userId: string): Promise<UserSettings> {
    const row = await this.db.one<{ settings: Partial<UserSettings> | null }>('SELECT settings FROM users WHERE id = $1', [userId]);
    const stored = row?.settings ?? {};
    return {
      skipTitles: Array.isArray(stored.skipTitles) ? stored.skipTitles.filter((entry): entry is string => typeof entry === 'string') : [],
      includeDrafts: stored.includeDrafts === true,
    };
  }

  async setSettings(userId: string, settings: UserSettings): Promise<void> {
    await this.db.query('UPDATE users SET settings = $1::jsonb WHERE id = $2', [JSON.stringify(settings), userId]);
  }

  /** Null as well when the token was sealed with a key this process no longer has. */
  async gitHubToken(userId: string): Promise<string | null> {
    const row = await this.db.one<{ github_token: string | null }>('SELECT github_token FROM users WHERE id = $1', [userId]);
    return row?.github_token ? decrypt(this.secretKey, row.github_token) : null;
  }

  /** The Claude routine diffity fires to attend the user's sessions; null as well when its key no longer decrypts. */
  async routine(userId: string): Promise<{ url: string; key: string } | null> {
    const row = await this.db.one<{ routine_url: string | null; routine_key: string | null }>(
      'SELECT routine_url, routine_key FROM users WHERE id = $1',
      [userId],
    );
    const key = row?.routine_key ? decrypt(this.secretKey, row.routine_key) : null;
    return row?.routine_url && key ? { url: row.routine_url, key } : null;
  }

  /** A null URL clears the routine; an undefined key keeps the stored one. */
  async setRoutine(userId: string, url: string | null, key: string | null | undefined): Promise<void> {
    if (url === null) {
      await this.db.query('UPDATE users SET routine_url = NULL, routine_key = NULL WHERE id = $1', [userId]);
      return;
    }
    if (key === undefined) {
      await this.db.query('UPDATE users SET routine_url = $1 WHERE id = $2', [url, userId]);
      return;
    }
    await this.db.query('UPDATE users SET routine_url = $1, routine_key = $2 WHERE id = $3', [
      url,
      key === null ? null : encrypt(this.secretKey, key),
      userId,
    ]);
  }

  /** What the settings page shows of the routine: never the key. */
  async routineSettings(userId: string): Promise<{ url: string | null; keySet: boolean }> {
    const row = await this.db.one<{ routine_url: string | null; routine_key: string | null }>(
      'SELECT routine_url, routine_key FROM users WHERE id = $1',
      [userId],
    );
    return { url: row?.routine_url ?? null, keySet: !!row?.routine_key };
  }
}

export const WEB_SESSION_MAX_AGE_SECONDS = 30 * 24 * 60 * 60;

export class WebSessions {
  constructor(private readonly db: Db) {}

  /** The cookie value; the table holds only its hash. */
  async create(userId: string, now = Date.now()): Promise<string> {
    const token = randomToken();
    await this.db.query('INSERT INTO web_sessions (id_hash, user_id, created_at, expires_at) VALUES ($1, $2, $3, $4)', [
      sha256(token),
      userId,
      new Date(now).toISOString(),
      now + WEB_SESSION_MAX_AGE_SECONDS * 1000,
    ]);
    return token;
  }

  async userFor(token: string | undefined, now = Date.now()): Promise<string | null> {
    if (!token) {
      return null;
    }
    const row = await this.db.one<{ user_id: string; expires_at: number }>(
      'SELECT user_id, expires_at FROM web_sessions WHERE id_hash = $1',
      [sha256(token)],
    );
    if (!row || row.expires_at < now) {
      return null;
    }
    return row.user_id;
  }

  async destroy(token: string | undefined): Promise<void> {
    if (token) {
      await this.db.query('DELETE FROM web_sessions WHERE id_hash = $1', [sha256(token)]);
    }
  }
}
