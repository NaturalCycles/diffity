import { randomUUID } from 'node:crypto';
import type { Store } from './db.js';
import { decrypt, encrypt, randomToken, sha256 } from './crypto.js';

export interface UserSettings {
  shareReviews: 'private';
}

export interface User {
  id: string;
  email: string;
  name: string;
  settings: UserSettings;
}

interface UserRow {
  id: string;
  email: string;
  name: string;
  settings: string;
}

const DEFAULT_SETTINGS: UserSettings = { shareReviews: 'private' };

function rowToUser(row: UserRow): User {
  let settings: UserSettings = DEFAULT_SETTINGS;
  try {
    settings = { ...DEFAULT_SETTINGS, ...(JSON.parse(row.settings) as Partial<UserSettings>) };
  } catch {
    // A hand-edited row falls back to the defaults rather than locking its owner out.
  }
  return { id: row.id, email: row.email, name: row.name, settings };
}

export class Users {
  constructor(private readonly store: Store, private readonly secretKey: Buffer) {}

  findOrCreate(email: string, name?: string): User {
    const normalised = email.trim().toLowerCase();
    const existing = this.store.get<UserRow>('SELECT * FROM users WHERE email = ?', normalised);
    if (existing) {
      return rowToUser(existing);
    }
    const id = randomUUID();
    this.store.run(
      'INSERT INTO users (id, email, name, created_at) VALUES (?, ?, ?, ?)',
      id,
      normalised,
      name?.trim() || normalised,
      new Date().toISOString(),
    );
    return this.get(id)!;
  }

  get(id: string): User | null {
    const row = this.store.get<UserRow>('SELECT * FROM users WHERE id = ?', id);
    return row ? rowToUser(row) : null;
  }

  setGitHubToken(userId: string, token: string | null): void {
    this.store.run(
      'UPDATE users SET github_token = ? WHERE id = ?',
      token ? encrypt(this.secretKey, token) : null,
      userId,
    );
  }

  /** Null as well when the token was sealed with a key this process no longer has. */
  gitHubToken(userId: string): string | null {
    const row = this.store.get<{ github_token: string | null }>('SELECT github_token FROM users WHERE id = ?', userId);
    return row?.github_token ? decrypt(this.secretKey, row.github_token) : null;
  }
}

const WEB_SESSION_DAYS = 30;

export class WebSessions {
  constructor(private readonly store: Store) {}

  /** The cookie value; the table holds only its hash. */
  create(userId: string, now = Date.now()): string {
    const token = randomToken();
    this.store.run(
      'INSERT INTO web_sessions (id_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)',
      sha256(token),
      userId,
      new Date(now).toISOString(),
      now + WEB_SESSION_DAYS * 24 * 60 * 60 * 1000,
    );
    return token;
  }

  userFor(token: string | undefined, now = Date.now()): string | null {
    if (!token) {
      return null;
    }
    const row = this.store.get<{ user_id: string; expires_at: number }>(
      'SELECT user_id, expires_at FROM web_sessions WHERE id_hash = ?',
      sha256(token),
    );
    if (!row || row.expires_at < now) {
      return null;
    }
    return row.user_id;
  }

  destroy(token: string | undefined): void {
    if (token) {
      this.store.run('DELETE FROM web_sessions WHERE id_hash = ?', sha256(token));
    }
  }

  static maxAgeSeconds(): number {
    return WEB_SESSION_DAYS * 24 * 60 * 60;
  }
}
