import { randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { getHeadHash, getDiffityDir, getRepoRoot } from '@diffity/git';
import { getDb, queryAll, queryOne } from './db.js';
import { reanchorInWorkingTree } from './anchor.js';
import { carryReviewRun } from './review-run.js';
import { updateThreadLines } from './threads.js';

export interface Session {
  id: string;
  ref: string;
  headHash: string;
}

function sessionFilePath(): string {
  return join(getDiffityDir(), 'current-session');
}

export function findOrCreateSession(ref: string): Session {
  const db = getDb();
  const headHash = getHeadHash();

  const repoRoot = getRepoRoot();

  const existing = queryOne<{ id: string; ref: string; head_hash: string }>(
    'SELECT id, ref, head_hash FROM review_sessions WHERE ref = ? AND head_hash = ? AND repo_root IS ?',
    ref,
    headHash,
    repoRoot,
  );

  if (existing) {
    const session: Session = { id: existing.id, ref: existing.ref, headHash: existing.head_hash };
    writeFileSync(sessionFilePath(), JSON.stringify(session));
    return session;
  }

  // A session is identified by the commit as well as the ref, so committing creates a new
  // one. Anything still open has to come with it: the whole point of reviewing your own
  // change is to act on the findings, and acting on them moves HEAD.
  const previous = queryOne<{ id: string }>(
    'SELECT id FROM review_sessions WHERE ref = ? AND repo_root IS ? ORDER BY created_at DESC, rowid DESC LIMIT 1',
    ref,
    repoRoot,
  );

  const id = randomUUID();
  db.prepare(
    'INSERT INTO review_sessions (id, ref, head_hash, repo_root) VALUES (?, ?, ?, ?)'
  ).run(id, ref, headHash, repoRoot);

  if (previous) {
    carryForward(previous.id, id);
  }

  const session: Session = { id, ref, headHash };
  writeFileSync(sessionFilePath(), JSON.stringify(session));
  return session;
}

/**
 * Moves rather than copies, so thread ids stay stable and nothing is duplicated. Threads that
 * were resolved or dismissed stay behind: they belong to the commit where they were dealt with,
 * and reopening them on every later commit would be noise.
 *
 * Line numbers are not re-anchored yet, so a thread whose code moved still points at the line
 * it was written against.
 */
export function carryForward(fromSessionId: string, toSessionId: string): void {
  const db = getDb();

  db.prepare(
    "UPDATE comment_threads SET session_id = ? WHERE session_id = ? AND status = 'open'",
  ).run(toSessionId, fromSessionId);

  db.prepare('UPDATE tours SET session_id = ? WHERE session_id = ?').run(
    toSessionId,
    fromSessionId,
  );

  carryReviewRun(fromSessionId, toSessionId);
  reanchorThreads(toSessionId);
}

/**
 * A finding that outlives the commit it was written against points at a line that has since
 * moved. Only the new side is re-anchored: a comment on a removed line has nothing to follow.
 */
function reanchorThreads(sessionId: string): void {
  const threads = queryAll<{
    id: string;
    file_path: string;
    side: string;
    start_line: number;
    anchor_content: string | null;
  }>(
    "SELECT id, file_path, side, start_line, anchor_content FROM comment_threads WHERE session_id = ? AND status = 'open' AND side = 'new' AND anchor_content IS NOT NULL",
    sessionId,
  );

  for (const thread of threads) {
    const moved = reanchorInWorkingTree(thread.file_path, thread.anchor_content!, thread.start_line);
    if (moved && moved.startLine !== thread.start_line) {
      updateThreadLines(thread.id, moved.startLine, moved.endLine);
    }
  }
}

/**
 * The session a request is about. A browser tab holds whichever id it loaded with, and a commit
 * since then will have carried the threads into a newer session for the same ref — so honouring a
 * stale id literally would tell the tab the review is empty.
 */
export function resolveSessionId(sessionId: string | null | undefined): string {
  if (!sessionId) {
    return getCurrentSession()?.id ?? '';
  }

  const known = queryOne<{ ref: string; repo_root: string | null }>(
    'SELECT ref, repo_root FROM review_sessions WHERE id = ?',
    sessionId,
  );
  if (!known) {
    return sessionId;
  }

  const newest = queryOne<{ id: string }>(
    'SELECT id FROM review_sessions WHERE ref = ? AND repo_root IS ? ORDER BY created_at DESC, rowid DESC LIMIT 1',
    known.ref,
    known.repo_root,
  );

  return newest?.id ?? sessionId;
}

export function getCurrentSession(): Session | null {
  try {
    const raw = readFileSync(sessionFilePath(), 'utf-8');
    return JSON.parse(raw) as Session;
  } catch {
    return null;
  }
}
