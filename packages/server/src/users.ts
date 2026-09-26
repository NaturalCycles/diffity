import { randomUUID } from 'node:crypto';
import type { Db } from './db.js';
import { decrypt, encrypt, randomToken, sha256 } from './crypto.js';

export interface UserSettings {
  shareReviews: 'private';
}

export interface User {
  id: string;
  email: string;
  name: string;
  settings: UserSettings;
  githubLogin: string | null;
}

interface UserRow {
  id: string;
  email: string;
  name: string;
  settings: string;
  github_login: string | null;
}

const DEFAULT_SETTINGS: UserSettings = { shareReviews: 'private' };

function rowToUser(row: UserRow): User {
  let settings: UserSettings = DEFAULT_SETTINGS;
  try {
    settings = { ...DEFAULT_SETTINGS, ...(JSON.parse(row.settings) as Partial<UserSettings>) };
  } catch {
    // A hand-edited row falls back to the defaults rather than locking its owner out.
  }
  return { id: row.id, email: row.email, name: row.name, settings, githubLogin: row.github_login };
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

  /** Null as well when the token was sealed with a key this process no longer has. */
  async gitHubToken(userId: string): Promise<string | null> {
    const row = await this.db.one<{ github_token: string | null }>('SELECT github_token FROM users WHERE id = $1', [userId]);
    return row?.github_token ? decrypt(this.secretKey, row.github_token) : null;
  }
}

const WEB_SESSION_DAYS = 30;

export class WebSessions {
  constructor(private readonly db: Db) {}

  /** The cookie value; the table holds only its hash. */
  async create(userId: string, now = Date.now()): Promise<string> {
    const token = randomToken();
    await this.db.query('INSERT INTO web_sessions (id_hash, user_id, created_at, expires_at) VALUES ($1, $2, $3, $4)', [
      sha256(token),
      userId,
      new Date(now).toISOString(),
      now + WEB_SESSION_DAYS * 24 * 60 * 60 * 1000,
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

  static maxAgeSeconds(): number {
    return WEB_SESSION_DAYS * 24 * 60 * 60;
  }
}
