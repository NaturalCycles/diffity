import { randomUUID } from 'node:crypto';
import {
  isAuthorType,
  isCommentKind,
  isCommentSide,
  isThreadStatus,
  type AuthorType,
  type Comment,
  type CommentAuthor,
  type CommentKind,
  type CommentSide,
  type CommentThread,
  type LiveIntent,
  type ThreadStatus,
} from '@diffity/api';
import { getDb, queryAll, queryOne } from './db.js';
import { normaliseIntent } from './live-intent.js';

export type { CommentKind, ThreadStatus } from '@diffity/api';
export type ThreadAuthor = CommentAuthor;
export type ThreadComment = Comment;
export type Thread = CommentThread;

/** The wire carries only real intents; anything an old row holds is read as a question. */
function intentOrNull(value: string | null | undefined): LiveIntent | null {
  return value == null ? null : normaliseIntent(value);
}

// Enum columns are narrowed on the way out rather than trusted: rows may predate validation at
// the server boundary, or come from a newer schema than this build knows.
export function normaliseSide(value: string): CommentSide {
  return isCommentSide(value) ? value : 'new';
}

function normaliseStatus(value: string): ThreadStatus {
  return isThreadStatus(value) ? value : 'open';
}

/** Absent means review: every comment written before kinds existed keeps its meaning. */
function normaliseKind(value: string | null | undefined): CommentKind {
  return isCommentKind(value) ? value : 'review';
}

function normaliseAuthorType(value: string): AuthorType {
  return isAuthorType(value) ? value : 'user';
}

interface ThreadRow {
  submitted_at?: string | null;
  submitted_review_url?: string | null;
  submitted_body?: string | null;
  submitted_head_sha?: string | null;
  github_comment_id?: number | null;
  id: string;
  session_id: string;
  file_path: string;
  side: string;
  start_line: number;
  end_line: number;
  status: string;
  anchor_content: string | null;
  created_at: string;
  updated_at: string;
}

interface CommentRow {
  id: string;
  thread_id: string;
  author_name: string;
  author_type: string;
  body: string;
  kind?: string | null;
  created_at: string;
  live_requested_at?: string | null;
  live_intent?: string | null;
  live_claimed_at?: string | null;
  live_answered_at?: string | null;
}

function rowToThread(row: ThreadRow, comments: ThreadComment[]): Thread {
  return {
    id: row.id,
    sessionId: row.session_id,
    filePath: row.file_path,
    side: normaliseSide(row.side),
    startLine: row.start_line,
    endLine: row.end_line,
    status: normaliseStatus(row.status),
    anchorContent: row.anchor_content,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    submittedAt: row.submitted_at ?? null,
    submittedReviewUrl: row.submitted_review_url ?? null,
    submittedBody: row.submitted_body ?? null,
    submittedHeadSha: row.submitted_head_sha ?? null,
    githubCommentId: row.github_comment_id ?? null,
    comments,
  };
}

function rowToComment(row: CommentRow): ThreadComment {
  return {
    id: row.id,
    author: { name: row.author_name, type: normaliseAuthorType(row.author_type) },
    body: row.body,
    kind: normaliseKind(row.kind),
    createdAt: row.created_at,
    liveRequestedAt: row.live_requested_at ?? null,
    liveIntent: intentOrNull(row.live_intent),
    liveClaimedAt: row.live_claimed_at ?? null,
    liveAnsweredAt: row.live_answered_at ?? null,
  };
}

function getCommentsForThreads(threadIds: string[]): Map<string, ThreadComment[]> {
  if (threadIds.length === 0) {
    return new Map();
  }
  const placeholders = threadIds.map(() => '?').join(', ');
  const rows = queryAll<CommentRow>(
    `SELECT * FROM comments WHERE thread_id IN (${placeholders}) ORDER BY created_at ASC`,
    ...threadIds,
  );

  const map = new Map<string, ThreadComment[]>();
  for (const row of rows) {
    const comments = map.get(row.thread_id) ?? [];
    comments.push(rowToComment(row));
    map.set(row.thread_id, comments);
  }
  return map;
}

function getCommentsForThread(threadId: string): ThreadComment[] {
  const map = getCommentsForThreads([threadId]);
  return map.get(threadId) ?? [];
}

export interface SubmittedIn {
  reviewUrl?: string | null;
  headSha?: string | null;
}

export function markThreadsSubmitted(
  sent: (string | { threadId: string; body?: string; githubCommentId?: number })[],
  submittedIn: SubmittedIn = {},
): void {
  if (sent.length === 0) {
    return;
  }

  const db = getDb();
  const statement = db.prepare(
    `UPDATE comment_threads
        SET submitted_at = strftime('%Y-%m-%d %H:%M:%f', 'now'),
            submitted_review_url = ?,
            submitted_head_sha = ?,
            submitted_body = COALESCE(?, submitted_body),
            github_comment_id = COALESCE(?, github_comment_id)
      WHERE id = ?`,
  );

  for (const entry of sent) {
    const { threadId, body, githubCommentId } =
      typeof entry === 'string' ? { threadId: entry, body: undefined, githubCommentId: undefined } : entry;
    statement.run(
      submittedIn.reviewUrl ?? null,
      submittedIn.headSha ?? null,
      body ?? null,
      githubCommentId ?? null,
      threadId,
    );
  }
}

/** Records which forge comment a thread exists as, once that is learned. */
export function setThreadForgeComment(threadId: string, githubCommentId: number): void {
  getDb()
    .prepare('UPDATE comment_threads SET github_comment_id = ? WHERE id = ?')
    .run(githubCommentId, threadId);
}

export function updateThreadPath(threadId: string, filePath: string): void {
  getDb()
    .prepare('UPDATE comment_threads SET file_path = ? WHERE id = ?')
    .run(filePath, threadId);
}

export function updateThreadLines(threadId: string, startLine: number, endLine: number): void {
  const db = getDb();
  db.prepare('UPDATE comment_threads SET start_line = ?, end_line = ? WHERE id = ?').run(
    startLine,
    endLine,
    threadId,
  );
}

export function createThread(
  sessionId: string,
  filePath: string,
  side: CommentSide,
  startLine: number,
  endLine: number,
  body: string,
  author: ThreadAuthor,
  anchorContent?: string,
  kind: CommentKind = 'review',
): Thread {
  const db = getDb();
  const threadId = randomUUID();
  const commentId = randomUUID();
  const now = new Date().toISOString();

  const cleanBody = body;

  db.prepare(
    'INSERT INTO comment_threads (id, session_id, file_path, side, start_line, end_line, anchor_content, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
  ).run(threadId, sessionId, filePath, side, startLine, endLine, anchorContent ?? null, now, now);

  db.prepare(
    'INSERT INTO comments (id, thread_id, author_name, author_type, body, kind, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
  ).run(commentId, threadId, author.name, author.type, cleanBody, kind, now);

  return {
    id: threadId,
    sessionId,
    filePath,
    side,
    startLine,
    endLine,
    status: 'open',
    anchorContent: anchorContent ?? null,
    createdAt: now,
    updatedAt: now,
    submittedAt: null,
    submittedReviewUrl: null,
    submittedBody: null,
    submittedHeadSha: null,
    githubCommentId: null,
    comments: [{
      id: commentId,
      author,
      body: cleanBody,
      kind,
      createdAt: now,
      liveRequestedAt: null,
    liveIntent: null,
      liveClaimedAt: null,
      liveAnsweredAt: null,
    }],
  };
}

interface JoinedRow extends ThreadRow {
  c_id: string | null;
  c_author_name: string | null;
  c_author_type: string | null;
  c_body: string | null;
  c_kind: string | null;
  c_created_at: string | null;
  c_live_requested_at: string | null;
  c_live_intent: string | null;
  c_live_claimed_at: string | null;
  c_live_answered_at: string | null;
}

export function getThreadsForSession(sessionId: string, status?: ThreadStatus): Thread[] {
  const where = status
    ? 'WHERE t.session_id = ? AND t.status = ?'
    : 'WHERE t.session_id = ?';
  const params = status ? [sessionId, status] : [sessionId];

  const rows = queryAll<JoinedRow>(`
    SELECT t.*,
           c.id AS c_id, c.author_name AS c_author_name, c.author_type AS c_author_type,
           c.body AS c_body, c.kind AS c_kind, c.created_at AS c_created_at,
           c.live_requested_at AS c_live_requested_at, c.live_intent AS c_live_intent,
           c.live_claimed_at AS c_live_claimed_at,
           c.live_answered_at AS c_live_answered_at
    FROM comment_threads t
    LEFT JOIN comments c ON c.thread_id = t.id
    ${where}
    ORDER BY t.created_at ASC, c.created_at ASC
  `, ...params);

  const threads = new Map<string, Thread>();
  for (const row of rows) {
    let thread = threads.get(row.id);
    if (!thread) {
      thread = rowToThread(row, []);
      threads.set(row.id, thread);
    }
    if (row.c_id) {
      thread.comments.push({
        id: row.c_id,
        author: { name: row.c_author_name!, type: normaliseAuthorType(row.c_author_type!) },
        body: row.c_body!,
        kind: normaliseKind(row.c_kind),
        createdAt: row.c_created_at!,
        liveRequestedAt: row.c_live_requested_at ?? null,
        liveIntent: intentOrNull(row.c_live_intent),
        liveClaimedAt: row.c_live_claimed_at ?? null,
        liveAnsweredAt: row.c_live_answered_at ?? null,
      });
    }
  }
  return Array.from(threads.values());
}

export function getThread(idOrPrefix: string): Thread | null {
  let row = queryOne<ThreadRow>('SELECT * FROM comment_threads WHERE id = ?', idOrPrefix);

  if (!row && idOrPrefix.length >= 8) {
    row = queryOne<ThreadRow>('SELECT * FROM comment_threads WHERE id LIKE ?', idOrPrefix + '%');
  }

  if (!row) {
    return null;
  }

  return rowToThread(row, getCommentsForThread(row.id));
}

export function addReply(
  threadId: string,
  body: string,
  author: ThreadAuthor,
  kind: CommentKind = 'review',
): ThreadComment {
  const db = getDb();
  const commentId = randomUUID();
  const now = new Date().toISOString();
  const cleanBody = body;

  db.prepare(
    'INSERT INTO comments (id, thread_id, author_name, author_type, body, kind, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
  ).run(commentId, threadId, author.name, author.type, cleanBody, kind, now);

  if (author.type === 'user') {
    db.prepare(
      'UPDATE comment_threads SET status = ?, updated_at = ? WHERE id = ?'
    ).run('open', now, threadId);
  } else {
    db.prepare(
      'UPDATE comment_threads SET updated_at = ? WHERE id = ?'
    ).run(now, threadId);
  }

  return {
    id: commentId,
    author,
    body: cleanBody,
    kind,
    createdAt: now,
    liveRequestedAt: null,
    liveIntent: null,
    liveClaimedAt: null,
    liveAnsweredAt: null,
  };
}

export function updateThreadStatus(threadId: string, status: ThreadStatus, summaryBody?: string, summaryAuthor?: ThreadAuthor): void {
  const db = getDb();
  const now = new Date().toISOString();

  db.prepare(
    'UPDATE comment_threads SET status = ?, updated_at = ? WHERE id = ?'
  ).run(status, now, threadId);

  if (summaryBody && summaryAuthor) {
    const commentId = randomUUID();
    const cleanSummary = summaryBody;
    db.prepare(
      'INSERT INTO comments (id, thread_id, author_name, author_type, body, created_at) VALUES (?, ?, ?, ?, ?, ?)'
    ).run(commentId, threadId, summaryAuthor.name, summaryAuthor.type, cleanSummary, now);
  }
}

export function deleteThread(threadId: string): void {
  const db = getDb();
  db.prepare('DELETE FROM comment_threads WHERE id = ?').run(threadId);
}

export function deleteAllThreadsForSession(sessionId: string): void {
  const db = getDb();
  db.prepare('DELETE FROM comment_threads WHERE session_id = ?').run(sessionId);
}

export function editComment(commentId: string, body: string): void {
  const db = getDb();
  db.prepare('UPDATE comments SET body = ? WHERE id = ?').run(body, commentId);
}

export function deleteComment(commentId: string): void {
  const db = getDb();
  const comment = queryOne<{ thread_id: string }>('SELECT thread_id FROM comments WHERE id = ?', commentId);
  if (!comment) {
    return;
  }

  db.prepare('DELETE FROM comments WHERE id = ?').run(commentId);

  const remaining = queryOne<{ count: number }>('SELECT COUNT(*) as count FROM comments WHERE thread_id = ?', comment.thread_id);
  if (remaining?.count === 0) {
    db.prepare('DELETE FROM comment_threads WHERE id = ?').run(comment.thread_id);
  }
}
