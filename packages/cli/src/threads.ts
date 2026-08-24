import { randomUUID } from 'node:crypto';
import { getDb, queryAll, queryOne } from './db.js';
import { unescapeMarkdown } from './unescape.js';

export interface ThreadAuthor {
  name: string;
  type: 'user' | 'agent';
}

export interface ThreadComment {
  id: string;
  author: ThreadAuthor;
  body: string;
  createdAt: string;
}

export type ThreadStatus = 'open' | 'resolved' | 'dismissed';

export interface Thread {
  id: string;
  sessionId: string;
  filePath: string;
  side: string;
  startLine: number;
  endLine: number;
  status: ThreadStatus;
  anchorContent: string | null;
  createdAt: string;
  updatedAt: string;
  /** When this finding was last sent to the forge, or null while it has never left the machine. */
  submittedAt: string | null;
  submittedReviewUrl: string | null;
  submittedHeadSha: string | null;
  comments: ThreadComment[];
}

interface ThreadRow {
  submitted_at?: string | null;
  submitted_review_url?: string | null;
  submitted_head_sha?: string | null;
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
  created_at: string;
}

function rowToThread(row: ThreadRow, comments: ThreadComment[]): Thread {
  return {
    id: row.id,
    sessionId: row.session_id,
    filePath: row.file_path,
    side: row.side,
    startLine: row.start_line,
    endLine: row.end_line,
    status: row.status as ThreadStatus,
    anchorContent: row.anchor_content,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    submittedAt: row.submitted_at ?? null,
    submittedReviewUrl: row.submitted_review_url ?? null,
    submittedHeadSha: row.submitted_head_sha ?? null,
    comments,
  };
}

function rowToComment(row: CommentRow): ThreadComment {
  return {
    id: row.id,
    author: { name: row.author_name, type: row.author_type as 'user' | 'agent' },
    body: row.body,
    createdAt: row.created_at,
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

export function markThreadsSubmitted(threadIds: string[], submittedIn: SubmittedIn = {}): void {
  if (threadIds.length === 0) {
    return;
  }

  const db = getDb();
  const placeholders = threadIds.map(() => '?').join(', ');
  db.prepare(
    `UPDATE comment_threads
        SET submitted_at = datetime('now'),
            submitted_review_url = ?,
            submitted_head_sha = ?
      WHERE id IN (${placeholders})`,
  ).run(submittedIn.reviewUrl ?? null, submittedIn.headSha ?? null, ...threadIds);
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
  side: string,
  startLine: number,
  endLine: number,
  body: string,
  author: ThreadAuthor,
  anchorContent?: string,
): Thread {
  const db = getDb();
  const threadId = randomUUID();
  const commentId = randomUUID();
  const now = new Date().toISOString();

  const cleanBody = unescapeMarkdown(body);

  db.prepare(
    'INSERT INTO comment_threads (id, session_id, file_path, side, start_line, end_line, anchor_content, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
  ).run(threadId, sessionId, filePath, side, startLine, endLine, anchorContent ?? null, now, now);

  db.prepare(
    'INSERT INTO comments (id, thread_id, author_name, author_type, body, created_at) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(commentId, threadId, author.name, author.type, cleanBody, now);

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
    submittedHeadSha: null,
    comments: [{
      id: commentId,
      author,
      body: cleanBody,
      createdAt: now,
    }],
  };
}

interface JoinedRow extends ThreadRow {
  c_id: string | null;
  c_author_name: string | null;
  c_author_type: string | null;
  c_body: string | null;
  c_created_at: string | null;
}

export function getThreadsForSession(sessionId: string, status?: ThreadStatus): Thread[] {
  const where = status
    ? 'WHERE t.session_id = ? AND t.status = ?'
    : 'WHERE t.session_id = ?';
  const params = status ? [sessionId, status] : [sessionId];

  const rows = queryAll<JoinedRow>(`
    SELECT t.*,
           c.id AS c_id, c.author_name AS c_author_name, c.author_type AS c_author_type,
           c.body AS c_body, c.created_at AS c_created_at
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
        author: { name: row.c_author_name!, type: row.c_author_type as 'user' | 'agent' },
        body: row.c_body!,
        createdAt: row.c_created_at!,
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

export function addReply(threadId: string, body: string, author: ThreadAuthor): ThreadComment {
  const db = getDb();
  const commentId = randomUUID();
  const now = new Date().toISOString();
  const cleanBody = unescapeMarkdown(body);

  db.prepare(
    'INSERT INTO comments (id, thread_id, author_name, author_type, body, created_at) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(commentId, threadId, author.name, author.type, cleanBody, now);

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
    createdAt: now,
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
    const cleanSummary = unescapeMarkdown(summaryBody);
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
  db.prepare('UPDATE comments SET body = ? WHERE id = ?').run(unescapeMarkdown(body), commentId);
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
