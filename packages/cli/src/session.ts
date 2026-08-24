import { randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { getHeadHash, getDiffityDir, getRepoRoot, getCurrentBranch, WORKING_TREE_REFS } from '@diffity/git';
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

/** Browsing files is not reviewing a change, and its notes are not about a diff. */
const TREE_REF = '__tree__';

/**
 * What a ref asks to review. Sessions continue each other only within one of these: the base a
 * branch is compared against changes every time the branch is updated, but reviewing uncommitted
 * work, reviewing a branch against a base, and browsing the file tree are three different
 * activities over three different sets of lines.
 */
type ReviewScope = 'tree' | 'working-tree' | 'base';

function reviewScope(ref: string): ReviewScope {
  if (ref === TREE_REF) {
    return 'tree';
  }
  return WORKING_TREE_REFS.has(ref) ? 'working-tree' : 'base';
}

/**
 * A row written before sessions recorded their branch has none. It still belongs to this checkout
 * — a working tree is on one branch at a time — so an unknown branch matches rather than
 * stranding the findings it holds.
 */
function branchMatches(rowBranch: string | null, branch: string): boolean {
  return rowBranch === null || rowBranch === branch;
}

/**
 * Every session for this checkout that is part of the same review, newest first.
 */
function sessionsInScope(
  repoRoot: string | null,
  branch: string,
  ref: string,
): { id: string; ref: string }[] {
  const scope = reviewScope(ref);
  return queryAll<{ id: string; ref: string; branch: string | null }>(
    'SELECT id, ref, branch FROM review_sessions WHERE repo_root IS ? ORDER BY created_at DESC, rowid DESC',
    repoRoot,
  ).filter(row => branchMatches(row.branch, branch) && reviewScope(row.ref) === scope);
}

export function findOrCreateSession(ref: string): Session {
  const headHash = getHeadHash();
  const repoRoot = getRepoRoot();
  const branch = getCurrentBranch();

  const { session, created } = openSession(ref, headHash, repoRoot, branch);

  // A session is identified by the commit and the base as well, so both committing and updating
  // the branch from its base start a new one. Anything still open has to come along: the whole
  // point of reviewing your own change is to act on the findings, and acting on them moves HEAD.
  //
  // A superseded session is never deleted, so "a sibling exists" stays true forever and cannot be
  // what decides this. `/api/info` calls in here on a five-second poll, and the work below moves
  // rows and reads the working tree once per anchored finding.
  const siblings = sessionsInScope(repoRoot, branch, ref).filter(row => row.id !== session.id);
  const donors = sessionsHoldingWork(siblings.map(row => row.id));

  if (donors.length > 0) {
    gatherOpenWork(donors, session.id);
  }

  if (created || donors.length > 0) {
    // A run belongs to the session the review was last read through — the newest sibling, which is
    // not necessarily one holding findings. Taking one from any older sibling would bring a review
    // finished two commits ago back to life.
    if (siblings.length > 0) {
      carryReviewRun(siblings[0].id, session.id);
    }
    reanchorThreads(session.id);
  }

  writeFileSync(sessionFilePath(), JSON.stringify(session));
  return session;
}

/**
 * Which of these sessions still hold anything worth taking, newest first. A finding that has been
 * resolved stays where it was dealt with, so it is not work; an unfinished review run is, because
 * the page has to keep saying a review is under way across a commit.
 */
function sessionsHoldingWork(sessionIds: string[]): string[] {
  if (sessionIds.length === 0) {
    return [];
  }

  const placeholders = sessionIds.map(() => '?').join(', ');
  const holders = new Set(
    queryAll<{ session_id: string }>(
      `SELECT session_id FROM comment_threads WHERE status = 'open' AND session_id IN (${placeholders})
       UNION
       SELECT session_id FROM tours WHERE session_id IN (${placeholders})
       UNION
       SELECT session_id FROM review_runs WHERE finished_at IS NULL AND session_id IN (${placeholders})`,
      ...sessionIds,
      ...sessionIds,
      ...sessionIds,
    ).map(row => row.session_id),
  );

  return sessionIds.filter(id => holders.has(id));
}

function openSession(
  ref: string,
  headHash: string,
  repoRoot: string | null,
  branch: string,
): { session: Session; created: boolean } {
  const db = getDb();

  const existing = queryOne<{ id: string; ref: string; head_hash: string }>(
    `SELECT id, ref, head_hash FROM review_sessions
      WHERE ref = ? AND head_hash = ? AND repo_root IS ? AND (branch IS ? OR branch IS NULL)`,
    ref,
    headHash,
    repoRoot,
    branch,
  );

  if (existing) {
    db.prepare('UPDATE review_sessions SET branch = ? WHERE id = ? AND branch IS NULL').run(
      branch,
      existing.id,
    );
    return {
      session: { id: existing.id, ref: existing.ref, headHash: existing.head_hash },
      created: false,
    };
  }

  // A session written before sessions recorded their repository has no repo_root. Adopt it
  // instead of starting a fresh one, or upgrading would strand every finding it holds.
  const legacy = queryOne<{ id: string; ref: string; head_hash: string }>(
    'SELECT id, ref, head_hash FROM review_sessions WHERE ref = ? AND head_hash = ? AND repo_root IS NULL',
    ref,
    headHash,
  );

  if (legacy) {
    db.prepare('UPDATE review_sessions SET repo_root = ?, branch = ? WHERE id = ?').run(
      repoRoot,
      branch,
      legacy.id,
    );
    return {
      session: { id: legacy.id, ref: legacy.ref, headHash: legacy.head_hash },
      created: false,
    };
  }

  const id = randomUUID();
  db.prepare(
    'INSERT INTO review_sessions (id, ref, head_hash, repo_root, branch) VALUES (?, ?, ?, ?, ?)',
  ).run(id, ref, headHash, repoRoot, branch);

  return { session: { id, ref, headHash }, created: true };
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
  gatherOpenWork([fromSessionId], toSessionId);
  carryReviewRun(fromSessionId, toSessionId);
  reanchorThreads(toSessionId);
}

function gatherOpenWork(fromSessionIds: string[], toSessionId: string): void {
  // An empty list would render as `IN ()`, and getting that wrong once moved every thread there is.
  if (fromSessionIds.length === 0) {
    return;
  }

  const db = getDb();
  const placeholders = fromSessionIds.map(() => '?').join(', ');

  db.prepare(
    `UPDATE comment_threads SET session_id = ?
      WHERE status = 'open' AND session_id IN (${placeholders})`,
  ).run(toSessionId, ...fromSessionIds);

  db.prepare(`UPDATE tours SET session_id = ? WHERE session_id IN (${placeholders})`).run(
    toSessionId,
    ...fromSessionIds,
  );
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
 * The session a request is about. A browser tab holds whichever id it loaded with, and a commit or
 * a change of base since then will have carried the threads into a newer session for the same
 * branch — so honouring a stale id literally would tell the tab the review is empty.
 */
export function resolveSessionId(sessionId: string | null | undefined): string {
  if (!sessionId) {
    return getCurrentSession()?.id ?? '';
  }

  const known = queryOne<{ ref: string; repo_root: string | null; branch: string | null }>(
    'SELECT ref, repo_root, branch FROM review_sessions WHERE id = ?',
    sessionId,
  );
  if (!known) {
    return sessionId;
  }

  const [newest] = sessionsInScope(known.repo_root, known.branch, known.ref);

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
