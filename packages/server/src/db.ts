import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import pg, { type PoolConfig } from 'pg';
import { PGlite, types as pgliteTypes } from '@electric-sql/pglite';

export interface Queryable {
  query<T>(sql: string, params?: unknown[]): Promise<T[]>;
  one<T>(sql: string, params?: unknown[]): Promise<T | undefined>;
  /** Several statements, no parameters: migrations. */
  exec(sql: string): Promise<void>;
}

export interface Db extends Queryable {
  transaction<T>(work: (tx: Queryable) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

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
        github_login TEXT,
        github_access_token TEXT,
        github_access_expires_at BIGINT,
        github_refresh_token TEXT,
        github_refresh_expires_at BIGINT,
        created_at TEXT NOT NULL
      );

      CREATE TABLE web_sessions (
        id_hash TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        created_at TEXT NOT NULL,
        expires_at BIGINT NOT NULL
      );

      CREATE TABLE github_oauth_states (
        state_hash TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        expires_at BIGINT NOT NULL
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
        expires_at BIGINT NOT NULL
      );

      CREATE TABLE oauth_tokens (
        token_hash TEXT PRIMARY KEY,
        kind TEXT NOT NULL CHECK (kind IN ('access', 'refresh')),
        client_id TEXT NOT NULL REFERENCES oauth_clients(client_id) ON DELETE CASCADE,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        scopes TEXT NOT NULL,
        resource TEXT,
        expires_at BIGINT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX idx_oauth_tokens_user ON oauth_tokens(user_id);

      CREATE TABLE repos (
        id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        owner TEXT NOT NULL,
        name TEXT NOT NULL,
        UNIQUE (owner, name)
      );

      CREATE TABLE sessions (
        id TEXT PRIMARY KEY,
        seq BIGINT GENERATED ALWAYS AS IDENTITY,
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
        seq BIGINT GENERATED ALWAYS AS IDENTITY,
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
        github_comment_id BIGINT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX idx_threads_session ON threads(session_id);

      CREATE TABLE comments (
        id TEXT PRIMARY KEY,
        seq BIGINT GENERATED ALWAYS AS IDENTITY,
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
        seq BIGINT GENERATED ALWAYS AS IDENTITY,
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

/** Any constant; two instances starting together take turns migrating. */
const MIGRATION_LOCK = 5390;

/** Every expiry is epoch milliseconds, past what int4 holds, and exact in a JS number. */
const INT8 = 20;

export async function migrate(db: Db, migrations: Migration[] = MIGRATIONS): Promise<void> {
  await db.transaction(async tx => {
    await tx.query('SELECT pg_advisory_xact_lock($1)', [MIGRATION_LOCK]);
    await tx.exec('CREATE TABLE IF NOT EXISTS schema_version (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)');
    const applied = new Set((await tx.query<{ version: number }>('SELECT version FROM schema_version')).map(row => row.version));
    for (const migration of [...migrations].sort((a, b) => a.version - b.version)) {
      if (applied.has(migration.version)) {
        continue;
      }
      try {
        await tx.exec(migration.sql);
      } catch (err) {
        throw new Error(`Migration ${migration.version} failed: ${err instanceof Error ? err.message : err}`);
      }
      await tx.query('INSERT INTO schema_version (version, applied_at) VALUES ($1, $2)', [
        migration.version,
        new Date().toISOString(),
      ]);
    }
  });
}

export async function schemaVersion(db: Queryable): Promise<number> {
  return (await db.one<{ version: number | null }>('SELECT MAX(version) AS version FROM schema_version'))?.version ?? 0;
}

type PgClient = pg.Pool | pg.PoolClient;

function pgQueryable(client: PgClient): Queryable {
  return {
    query: async <T>(sql: string, params: unknown[] = []) => (await client.query(sql, params)).rows as T[],
    one: async <T>(sql: string, params: unknown[] = []) => (await client.query(sql, params)).rows[0] as T | undefined,
    exec: async (sql: string) => {
      await client.query(sql);
    },
  };
}

/**
 * Cloud SQL's server certificate names the instance, not the private IP it is reached on, so the
 * chain is verified against the CA and the host name is not: libpq's `verify-ca`. The CA comes as
 * a secret's content, so the file-based URL parameters are dropped.
 */
export function pgPoolConfig(databaseUrl: string, ca: string | null): PoolConfig {
  if (!ca) {
    return { connectionString: databaseUrl };
  }
  const url = new URL(databaseUrl);
  url.searchParams.delete('sslmode');
  url.searchParams.delete('sslrootcert');
  return { connectionString: url.href, ssl: { ca, rejectUnauthorized: true, checkServerIdentity: () => undefined } };
}

export function openPostgres(config: PoolConfig): Db {
  const pool = new pg.Pool({
    ...config,
    types: { getTypeParser: ((oid: number, format?: 'text' | 'binary') =>
      oid === INT8 ? Number : pg.types.getTypeParser(oid, format)) as typeof pg.types.getTypeParser },
  });
  return {
    ...pgQueryable(pool),
    transaction: async work => {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const result = await work(pgQueryable(client));
        await client.query('COMMIT');
        return result;
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        throw err;
      } finally {
        client.release();
      }
    },
    close: () => pool.end(),
  };
}

type PgliteLike = Pick<PGlite, 'query' | 'exec'>;

function pgliteQueryable(client: PgliteLike): Queryable {
  return {
    query: async <T>(sql: string, params: unknown[] = []) => (await client.query<T>(sql, params)).rows,
    one: async <T>(sql: string, params: unknown[] = []) => (await client.query<T>(sql, params)).rows[0],
    exec: async (sql: string) => {
      await client.exec(sql);
    },
  };
}

/** In memory without a directory. */
export async function openPglite(dataDir?: string): Promise<Db> {
  if (dataDir) {
    mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  }
  const db = await PGlite.create(dataDir, { parsers: { [pgliteTypes.INT8]: (value: string) => Number(value) } });
  return {
    ...pgliteQueryable(db),
    transaction: work => db.transaction(tx => work(pgliteQueryable(tx))),
    close: () => db.close(),
  };
}

export async function openDb(options: { databaseUrl: string | null; pgCa: string | null; dataDir: string }): Promise<Db> {
  const db = options.databaseUrl
    ? openPostgres(pgPoolConfig(options.databaseUrl, options.pgCa))
    : await openPglite(join(options.dataDir, 'pg'));
  try {
    await migrate(db);
  } catch (err) {
    await db.close();
    throw err;
  }
  return db;
}
