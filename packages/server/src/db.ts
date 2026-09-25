import { chmodSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';

export interface Migration {
  version: number;
  sql: string;
}

/** Applied in order, each once. A shipped migration is never edited; a change is a new one. */
export const MIGRATIONS: Migration[] = [
  {
    version: 1,
    sql: `
      CREATE TABLE users (
        id TEXT PRIMARY KEY,
        email TEXT NOT NULL UNIQUE,
        name TEXT NOT NULL,
        settings TEXT NOT NULL DEFAULT '{"shareReviews":"private"}',
        github_token TEXT,
        created_at TEXT NOT NULL
      );

      CREATE TABLE web_sessions (
        id_hash TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        created_at TEXT NOT NULL,
        expires_at INTEGER NOT NULL
      );

      CREATE TABLE oauth_clients (
        client_id TEXT PRIMARY KEY,
        client_secret_hash TEXT,
        metadata TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE oauth_codes (
        code_hash TEXT PRIMARY KEY,
        client_id TEXT NOT NULL REFERENCES oauth_clients(client_id) ON DELETE CASCADE,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        code_challenge TEXT NOT NULL,
        redirect_uri TEXT NOT NULL,
        scopes TEXT NOT NULL,
        resource TEXT,
        expires_at INTEGER NOT NULL
      );

      CREATE TABLE oauth_tokens (
        token_hash TEXT PRIMARY KEY,
        kind TEXT NOT NULL CHECK (kind IN ('access', 'refresh')),
        client_id TEXT NOT NULL REFERENCES oauth_clients(client_id) ON DELETE CASCADE,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        scopes TEXT NOT NULL,
        resource TEXT,
        expires_at INTEGER NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX idx_oauth_tokens_user ON oauth_tokens(user_id);

      CREATE TABLE repos (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        owner TEXT NOT NULL,
        name TEXT NOT NULL,
        UNIQUE (owner, name)
      );

      CREATE TABLE sessions (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        repo_id INTEGER NOT NULL REFERENCES repos(id),
        kind TEXT NOT NULL CHECK (kind IN ('pr', 'shas', 'patch')),
        pr_number INTEGER,
        pr_meta TEXT,
        base_sha TEXT NOT NULL,
        head_sha TEXT NOT NULL,
        review_started_at TEXT,
        review_finished_at TEXT,
        review_note TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL,
        UNIQUE (user_id, repo_id, base_sha, head_sha)
      );
      CREATE INDEX idx_sessions_user ON sessions(user_id, created_at);

      CREATE TABLE threads (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        file_path TEXT NOT NULL,
        side TEXT NOT NULL,
        start_line INTEGER NOT NULL,
        end_line INTEGER NOT NULL,
        status TEXT NOT NULL DEFAULT 'open',
        anchor_content TEXT,
        submitted_at TEXT,
        submitted_review_url TEXT,
        submitted_head_sha TEXT,
        submitted_body TEXT,
        github_comment_id INTEGER,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX idx_threads_session ON threads(session_id);

      CREATE TABLE comments (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
        author_name TEXT NOT NULL,
        author_type TEXT NOT NULL,
        body TEXT NOT NULL,
        kind TEXT NOT NULL DEFAULT 'review',
        created_at TEXT NOT NULL
      );
      CREATE INDEX idx_comments_thread ON comments(thread_id);

      CREATE TABLE tours (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        topic TEXT NOT NULL,
        body TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'building',
        created_at TEXT NOT NULL
      );
      CREATE INDEX idx_tours_session ON tours(session_id);

      CREATE TABLE tour_steps (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        tour_id TEXT NOT NULL REFERENCES tours(id) ON DELETE CASCADE,
        sort_order INTEGER NOT NULL,
        file_path TEXT NOT NULL,
        start_line INTEGER NOT NULL,
        end_line INTEGER NOT NULL,
        body TEXT NOT NULL DEFAULT '',
        annotation TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL
      );
      CREATE INDEX idx_tour_steps_tour ON tour_steps(tour_id);
    `,
  },
];

/**
 * node:sqlite types every row as `Record<string, SQLOutputValue>`, so the shape a query returns
 * has to be asserted; these keep the assertion in one place.
 */
export class Store {
  readonly db: DatabaseSync;

  constructor(path: string, migrations: Migration[] = MIGRATIONS) {
    mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    // Anchor content is source code and the tables hold token hashes; neither is for other users.
    for (const file of [path, `${path}-wal`, `${path}-shm`]) {
      try {
        chmodSync(file, 0o600);
      } catch {
        // The WAL siblings appear only once something has been written.
      }
    }
    this.db.exec('PRAGMA journal_mode = WAL');
    this.db.exec('PRAGMA foreign_keys = ON');
    this.db.exec('PRAGMA busy_timeout = 5000');
    migrate(this.db, migrations);
  }

  all<T>(sql: string, ...params: SQLInputValue[]): T[] {
    return this.db.prepare(sql).all(...params) as T[];
  }

  get<T>(sql: string, ...params: SQLInputValue[]): T | undefined {
    return this.db.prepare(sql).get(...params) as T | undefined;
  }

  run(sql: string, ...params: SQLInputValue[]): { changes: number } {
    const result = this.db.prepare(sql).run(...params);
    return { changes: Number(result.changes) };
  }

  transaction<T>(work: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = work();
      this.db.exec('COMMIT');
      return result;
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  schemaVersion(): number {
    return this.get<{ version: number }>('SELECT MAX(version) AS version FROM schema_version')?.version ?? 0;
  }

  close(): void {
    this.db.close();
  }
}

function migrate(db: DatabaseSync, migrations: Migration[]): void {
  db.exec('CREATE TABLE IF NOT EXISTS schema_version (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)');
  const applied = new Set(
    (db.prepare('SELECT version FROM schema_version').all() as { version: number }[]).map(row => row.version),
  );
  const ordered = [...migrations].sort((a, b) => a.version - b.version);
  for (const migration of ordered) {
    if (applied.has(migration.version)) {
      continue;
    }
    db.exec('BEGIN IMMEDIATE');
    try {
      db.exec(migration.sql);
      db.prepare('INSERT INTO schema_version (version, applied_at) VALUES (?, ?)').run(
        migration.version,
        new Date().toISOString(),
      );
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw new Error(`Migration ${migration.version} failed: ${err instanceof Error ? err.message : err}`);
    }
  }
}
