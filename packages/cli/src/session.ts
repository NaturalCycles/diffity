import { randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { getHeadHash, getDiffityDir, getRepoRoot, getCurrentBranch, getRenameStatus, WORKING_TREE_REFS } from '@diffity/git';
import { renamedPaths, followRename } from './renames.js';
import { getDb, queryAll, queryOne } from './db.js';
import { reanchorInWorkingTree } from './anchor.js';
import { carryReviewRun } from './review-run.js';
import { updateThreadLines, updateThreadPath } from './threads.js';

export interface Session {
  id: string;
  ref: string;
  headHash: string;
}

/**
 * `git rev-parse --abbrev-ref HEAD` says `HEAD` on a detached checkout, which is not a branch name.
 * Recorded as one it matches nothing, so a session written before `gh pr checkout` put the worktree
 * on a real branch is stranded along with its findings.
 */
function namedBranch(branch: string): string | null {
  return branch === 'HEAD' ? null : branch;
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
 * A branch nobody recorded matches any branch, on either side of the comparison. The row side is a
 * session written before sessions recorded their branch; the argument side is a tab asking about
 * one of those rows, through `resolveSessionId`, where the branch comes from the row rather than
 * from git. Either way it still belongs to this checkout — a working tree is on one branch at a
 * time — so an unknown branch matches rather than stranding the findings it holds.
 */
function branchMatches(rowBranch: string | null, branch: string | null): boolean {
  return rowBranch === null || branch === null || rowBranch === branch;
}

/**
 * Every session for this checkout that is part of the same review, newest first.
 */
function sessionsInScope(
  repoRoot: string | null,
  branch: string | null,
  ref: string,
): { id: string; ref: string }[] {
  const scope = reviewScope(ref);
  return queryAll<{ id: string; ref: string; branch: string | null }>(
    'SELECT id, ref, branch FROM review_sessions WHERE repo_root IS ? ORDER BY created_at DESC, rowid DESC',
    repoRoot,
  ).filter(row => branchMatches(row.branch, branch) && reviewScope(row.ref) === scope);
}

/**
 * Whether work may move from that session into this one.
 *
 * Two base refs belong to one review only because a branch's base moves as the branch is updated.
 * With no branch on this side, that reasoning is gone: nothing connects one base commit to another,
 * so two unrelated pull requests reviewed in one detached checkout look like a single review and the
 * newer takes the older's findings. Requiring the same ref strands a review instead of merging it
 * into somebody else's, which is the right way round to be wrong.
 *
 * Only taking work is guarded. Pointing a stale tab at a newer session shows the reader something
 * they can check, and a row with no branch of its own is a session from before branches were
 * recorded, which is a migration rather than a collision.
 */
function mayCarryFrom(rowRef: string, ref: string, branch: string | null): boolean {
  return branch !== null || rowRef === ref;
}

export function findOrCreateSession(ref: string): Session {
  const headHash = getHeadHash();
  const repoRoot = getRepoRoot();
  const branch = namedBranch(getCurrentBranch());

  const { session, created } = openSession(ref, headHash, repoRoot, branch);

  // A session is identified by the commit and the base as well, so both committing and updating
  // the branch from its base start a new one. Anything still open has to come along: the whole
  // point of reviewing your own change is to act on the findings, and acting on them moves HEAD.
  //
  // A superseded session is never deleted, so "a sibling exists" stays true forever and cannot be
  // what decides this. `/api/info` calls in here on a five-second poll, and the work below moves
  // rows and reads the working tree once per anchored finding.
  const siblings = sessionsInScope(repoRoot, branch, ref)
    .filter(row => row.id !== session.id)
    .filter(row => mayCarryFrom(row.ref, ref, branch));
  const donors = sessionsHoldingWork(siblings.map(row => row.id));

  if (donors.length > 0) {
    gatherOpenWork(donors, session.id);
  }

  // Before re-anchoring, which reads the working tree at each thread's path: a thread still
  // holding a pre-rename path would find nothing there and quietly keep its old lines.
  if (donors.length > 0) {
    followRenamesForSession(session.id, donors, headHash);
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
  branch: string | null,
): { session: Session; created: boolean } {
  const db = getDb();

  // A row for this branch and a row with no branch can both qualify. Prefer the one that names
  // the branch, rather than adopting the other and backfilling it alongside a row that already
  // exists for the same review.
  const existing = queryOne<{ id: string; ref: string; head_hash: string }>(
    `SELECT id, ref, head_hash FROM review_sessions
      WHERE ref = ? AND head_hash = ? AND repo_root IS ? AND (branch IS ? OR branch IS NULL)
      ORDER BY branch IS NULL`,
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
function donorHeads(donorIds: string[]): string[] {
  if (donorIds.length === 0) {
    return [];
  }
  const placeholders = donorIds.map(() => '?').join(', ');
  return queryAll<{ head_hash: string }>(
    `SELECT DISTINCT head_hash FROM review_sessions WHERE id IN (${placeholders})`,
    ...donorIds,
  ).map(row => row.head_hash);
}

/**
 * A carried thread keeps the path it was written against, and a commit that renames a file leaves
 * it pointing at one that is gone. Nothing renders a thread whose file is absent from the diff, so
 * the finding does not look wrong — it disappears.
 */
function followRenamesForSession(sessionId: string, donorIds: string[], toHead: string): void {
  const moves = new Map<string, string>();

  // Between the commit a finding was written against and the one it is carried to. The review's own
  // diff is no help: it shows the file only under the name it ends up with, so the rename is not
  // in it to find.
  for (const from of donorHeads(donorIds)) {
    if (from === toHead) continue;
    try {
      for (const [before, after] of renamedPaths(getRenameStatus(from, toHead))) {
        moves.set(before, after);
      }
    } catch {
      continue;
    }
  }

  if (moves.size === 0) {
    return;
  }

  const threads = queryAll<{ id: string; file_path: string }>(
    "SELECT id, file_path FROM comment_threads WHERE session_id = ? AND status = 'open'",
    sessionId,
  );

  for (const thread of threads) {
    const moved = followRename(thread.file_path, moves);
    if (moved !== thread.file_path) {
      updateThreadPath(thread.id, moved);
    }
  }
}

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
