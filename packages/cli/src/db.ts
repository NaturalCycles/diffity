import { chmodSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import type { DatabaseSync, SQLInputValue } from 'node:sqlite';
import { getDiffityDir } from '@diffity/git';

const require = createRequire(import.meta.url);

let db: DatabaseSync | null = null;

// Loaded lazily: `node:sqlite` only exists on Node >= 22.13, and a static import
// would abort the whole CLI at startup instead of showing this hint.
function loadSqlite(): { DatabaseSync: new (path: string) => DatabaseSync } {
  try {
    return require('node:sqlite');
  } catch {
    throw new Error(
      `diffity needs Node's built-in sqlite module, which requires Node >= 22.13 (running ${process.version}).`,
    );
  }
}

// The database holds `anchor_content` — the actual source lines a comment is attached to — so
// it must not be world-readable. WAL and shared-memory siblings hold the same content.
function restrictToOwner(dbPath: string): void {
  for (const path of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) {
    try {
      chmodSync(path, 0o600);
    } catch {
      // Not all siblings exist at every moment; the ones that do are what matter.
    }
  }
}

export function getDb(): DatabaseSync {
  if (db) {
    return db;
  }

  const { DatabaseSync: Database } = loadSqlite();
  const dbPath = join(getDiffityDir(), 'reviews.db');
  db = new Database(dbPath);
  restrictToOwner(dbPath);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  migrateDb(db);
  return db;
}

// node:sqlite types every row as `Record<string, SQLOutputValue>`, so the shape a
// query returns has to be asserted. These helpers keep that assertion in one place
// rather than at every call site.
export function queryAll<T>(sql: string, ...params: SQLInputValue[]): T[] {
  return getDb().prepare(sql).all(...params) as T[];
}

export function queryOne<T>(sql: string, ...params: SQLInputValue[]): T | undefined {
  return getDb().prepare(sql).get(...params) as T | undefined;
}

function migrateDb(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS review_sessions (
      id TEXT PRIMARY KEY,
      ref TEXT NOT NULL,
      head_hash TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS comment_threads (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL REFERENCES review_sessions(id),
      file_path TEXT NOT NULL,
      side TEXT NOT NULL,
      start_line INTEGER NOT NULL,
      end_line INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'open',
      anchor_content TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS comments (
      id TEXT PRIMARY KEY,
      thread_id TEXT NOT NULL REFERENCES comment_threads(id) ON DELETE CASCADE,
      author_name TEXT NOT NULL,
      author_type TEXT NOT NULL,
      body TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_threads_session ON comment_threads(session_id);
    CREATE INDEX IF NOT EXISTS idx_comments_thread ON comments(thread_id);

    CREATE TABLE IF NOT EXISTS tours (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL REFERENCES review_sessions(id),
      topic TEXT NOT NULL,
      body TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'building',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS tour_steps (
      id TEXT PRIMARY KEY,
      tour_id TEXT NOT NULL REFERENCES tours(id) ON DELETE CASCADE,
      sort_order INTEGER NOT NULL,
      file_path TEXT NOT NULL,
      start_line INTEGER NOT NULL,
      end_line INTEGER NOT NULL,
      body TEXT NOT NULL DEFAULT '',
      annotation TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS review_runs (
      session_id TEXT PRIMARY KEY REFERENCES review_sessions(id),
      started_at TEXT NOT NULL,
      finished_at TEXT,
      note TEXT NOT NULL DEFAULT ''
    );

    CREATE INDEX IF NOT EXISTS idx_tours_session ON tours(session_id);
    CREATE INDEX IF NOT EXISTS idx_tour_steps_tour ON tour_steps(tour_id);
  `);

  // The schema above is create-only, so a column added later needs its own step. Sessions were
  // identified by ref and commit alone, which two repositories sharing a data directory can
  // collide on -- `work` and `master` are not unique names.
  addColumn(db, 'review_sessions', 'repo_root', 'TEXT');
  // Which branch the review is of. The base it is compared against changes as the branch is
  // updated, so the base cannot be what identifies the review.
  addColumn(db, 'review_sessions', 'branch', 'TEXT');
  // Sending a finding to the forge is not the same as resolving it, so this is its own column
  // rather than a status: a submitted thread is still open until someone deals with it.
  // What a comment is for, which decides where it can go: a review comment can be posted, an
  // aside is the conversation about the review and stays here. Absent means review, so every
  // comment written before this keeps its meaning.
  addColumn(db, 'comments', 'kind', 'TEXT');
  // An aside can be a request for the agent to answer or amend. Three stamps rather than a status,
  // because "asked but not yet picked up" and "picked up but not answered" are both waiting, and
  // the page says different things about them.
  addColumn(db, 'comments', 'live_requested_at', 'TEXT');
  addColumn(db, 'comments', 'live_intent', 'TEXT');
  addColumn(db, 'comments', 'live_claimed_at', 'TEXT');
  addColumn(db, 'comments', 'live_answered_at', 'TEXT');
  addColumn(db, 'comment_threads', 'submitted_at', 'TEXT');
  // Sending is not resolving, and a timestamp alone cannot answer "did this go out against the
  // code that is there now?" — so the review and the commit it went out against are kept too.
  addColumn(db, 'comment_threads', 'submitted_review_url', 'TEXT');
  addColumn(db, 'comment_threads', 'submitted_head_sha', 'TEXT');
}

function addColumn(db: DatabaseSync, table: string, column: string, type: string): void {
  const existing = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  if (existing.some(row => row.name === column)) {
    return;
  }
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
}

export function closeDb(): void {
  if (db) {
    db.close();
    db = null;
  }
}
