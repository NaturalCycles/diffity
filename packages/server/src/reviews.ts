import { randomUUID } from 'node:crypto';
import {
  isAuthorType,
  isCommentKind,
  isCommentSide,
  isThreadStatus,
  isTourStatus,
  type Comment,
  type CommentAuthor,
  type CommentKind,
  type CommentSide,
  type CommentThread,
  type ReviewRun,
  type ThreadStatus,
  type Tour,
  type TourStatus,
  type TourStep,
} from '@diffity/api';
import type { Store } from './db.js';

export type SessionKind = 'pr' | 'shas' | 'patch';

export interface PrMeta {
  title: string;
  url: string;
  createdAt: string;
  author: string;
  body: string;
  headRef: string;
  baseRef: string;
}

export interface ReviewSessionRecord {
  id: string;
  userId: string;
  repoId: number;
  owner: string;
  repo: string;
  kind: SessionKind;
  prNumber: number | null;
  prMeta: PrMeta | null;
  baseSha: string;
  headSha: string;
  review: ReviewRun;
  createdAt: string;
}

export class AmbiguousIdError extends Error {}

interface SessionRow {
  id: string;
  user_id: string;
  repo_id: number;
  owner: string;
  name: string;
  kind: SessionKind;
  pr_number: number | null;
  pr_meta: string | null;
  base_sha: string;
  head_sha: string;
  review_started_at: string | null;
  review_finished_at: string | null;
  review_note: string;
  created_at: string;
}

interface ThreadRow {
  id: string;
  session_id: string;
  file_path: string;
  side: string;
  start_line: number;
  end_line: number;
  status: string;
  anchor_content: string | null;
  submitted_at: string | null;
  submitted_review_url: string | null;
  submitted_head_sha: string | null;
  submitted_body: string | null;
  github_comment_id: number | null;
  created_at: string;
  updated_at: string;
}

interface CommentRow {
  id: string;
  thread_id: string;
  author_name: string;
  author_type: string;
  body: string;
  kind: string;
  created_at: string;
}

interface TourRow {
  id: string;
  session_id: string;
  topic: string;
  body: string;
  status: string;
  created_at: string;
}

interface TourStepRow {
  id: string;
  tour_id: string;
  sort_order: number;
  file_path: string;
  start_line: number;
  end_line: number;
  body: string;
  annotation: string;
  created_at: string;
}

const SESSION_SELECT = `
  SELECT s.*, r.owner, r.name FROM sessions s JOIN repos r ON r.id = s.repo_id`;

function rowToSession(row: SessionRow): ReviewSessionRecord {
  let prMeta: PrMeta | null = null;
  if (row.pr_meta) {
    try {
      prMeta = JSON.parse(row.pr_meta) as PrMeta;
    } catch {
      prMeta = null;
    }
  }
  return {
    id: row.id,
    userId: row.user_id,
    repoId: row.repo_id,
    owner: row.owner,
    repo: row.name,
    kind: row.kind,
    prNumber: row.pr_number,
    prMeta,
    baseSha: row.base_sha,
    headSha: row.head_sha,
    review: {
      inProgress: row.review_started_at !== null && row.review_finished_at === null,
      startedAt: row.review_started_at,
      note: row.review_note,
    },
    createdAt: row.created_at,
  };
}

function rowToComment(row: CommentRow): Comment {
  return {
    id: row.id,
    author: { name: row.author_name, type: isAuthorType(row.author_type) ? row.author_type : 'user' },
    body: row.body,
    kind: isCommentKind(row.kind) ? row.kind : 'review',
    createdAt: row.created_at,
    liveRequestedAt: null,
    liveIntent: null,
    liveClaimedAt: null,
    liveAnsweredAt: null,
  };
}

function rowToThread(row: ThreadRow, comments: Comment[]): CommentThread {
  return {
    id: row.id,
    sessionId: row.session_id,
    filePath: row.file_path,
    side: isCommentSide(row.side) ? row.side : 'new',
    startLine: row.start_line,
    endLine: row.end_line,
    status: isThreadStatus(row.status) ? row.status : 'open',
    anchorContent: row.anchor_content,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    submittedAt: row.submitted_at,
    submittedReviewUrl: row.submitted_review_url,
    submittedBody: row.submitted_body,
    submittedHeadSha: row.submitted_head_sha,
    githubCommentId: row.github_comment_id,
    comments,
  };
}

function rowToStep(row: TourStepRow): TourStep {
  return {
    id: row.id,
    tourId: row.tour_id,
    sortOrder: row.sort_order,
    filePath: row.file_path,
    startLine: row.start_line,
    endLine: row.end_line,
    body: row.body,
    annotation: row.annotation,
    createdAt: row.created_at,
  };
}

function placeholders(values: unknown[]): string {
  return values.map(() => '?').join(', ');
}

/** `%` and `_` in a prefix would otherwise widen the match. */
function likePrefix(prefix: string): string {
  return prefix.replaceAll('\\', '\\\\').replaceAll('%', '\\%').replaceAll('_', '\\_') + '%';
}

/**
 * Every read and write here names the user it is for, and a row belonging to anyone else is
 * treated exactly like one that does not exist.
 */
export class Reviews {
  constructor(private readonly store: Store) {}

  /** A full id, or the 8-character prefix the CLI's ids accept, among this user's rows only. */
  private resolveId(table: 'sessions' | 'threads' | 'comments' | 'tours', userId: string, idOrPrefix: string): string | null {
    const exact = this.store.get<{ id: string }>(`SELECT id FROM ${table} WHERE id = ? AND user_id = ?`, idOrPrefix, userId);
    if (exact) {
      return exact.id;
    }
    if (idOrPrefix.length < 8) {
      return null;
    }
    const matches = this.store.all<{ id: string }>(
      `SELECT id FROM ${table} WHERE user_id = ? AND id LIKE ? ESCAPE '\\' LIMIT 2`,
      userId,
      likePrefix(idOrPrefix),
    );
    if (matches.length > 1) {
      throw new AmbiguousIdError(`${idOrPrefix} matches more than one ${table.replace(/s$/, '')}; give more of the id`);
    }
    return matches[0]?.id ?? null;
  }

  repoId(owner: string, name: string): number {
    this.store.run('INSERT INTO repos (owner, name) VALUES (?, ?) ON CONFLICT (owner, name) DO NOTHING', owner, name);
    return this.store.get<{ id: number }>('SELECT id FROM repos WHERE owner = ? AND name = ?', owner, name)!.id;
  }

  findOrCreateSession(input: {
    userId: string;
    owner: string;
    repo: string;
    kind: SessionKind;
    prNumber: number | null;
    prMeta: PrMeta | null;
    baseSha: string;
    headSha: string;
  }): { session: ReviewSessionRecord; created: boolean } {
    const repoId = this.repoId(input.owner, input.repo);
    const existing = this.store.get<{ id: string }>(
      'SELECT id FROM sessions WHERE user_id = ? AND repo_id = ? AND base_sha = ? AND head_sha = ?',
      input.userId,
      repoId,
      input.baseSha,
      input.headSha,
    );
    if (existing) {
      if (input.prMeta) {
        this.store.run(
          'UPDATE sessions SET pr_meta = ?, pr_number = COALESCE(pr_number, ?) WHERE id = ?',
          JSON.stringify(input.prMeta),
          input.prNumber,
          existing.id,
        );
      }
      return { session: this.getSession(input.userId, existing.id)!, created: false };
    }
    const id = randomUUID();
    this.store.run(
      `INSERT INTO sessions (id, user_id, repo_id, kind, pr_number, pr_meta, base_sha, head_sha, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id,
      input.userId,
      repoId,
      input.kind,
      input.prNumber,
      input.prMeta ? JSON.stringify(input.prMeta) : null,
      input.baseSha,
      input.headSha,
      new Date().toISOString(),
    );
    return { session: this.getSession(input.userId, id)!, created: true };
  }

  getSession(userId: string, idOrPrefix: string): ReviewSessionRecord | null {
    const id = this.resolveId('sessions', userId, idOrPrefix);
    if (!id) {
      return null;
    }
    const row = this.store.get<SessionRow>(`${SESSION_SELECT} WHERE s.id = ? AND s.user_id = ?`, id, userId);
    return row ? rowToSession(row) : null;
  }

  listSessions(userId: string, filter: { owner?: string; repo?: string; limit?: number } = {}): ReviewSessionRecord[] {
    const clauses = ['s.user_id = ?'];
    const params: (string | number)[] = [userId];
    if (filter.owner && filter.repo) {
      clauses.push('lower(r.owner) = lower(?) AND lower(r.name) = lower(?)');
      params.push(filter.owner, filter.repo);
    }
    params.push(filter.limit ?? 100);
    return this.store
      .all<SessionRow>(
        `${SESSION_SELECT} WHERE ${clauses.join(' AND ')} ORDER BY s.created_at DESC, s.rowid DESC LIMIT ?`,
        ...params,
      )
      .map(rowToSession);
  }

  /** Earlier sessions of the same pull request, newest first — where carried work comes from. */
  priorPrSessions(userId: string, repoId: number, prNumber: number, excludeId: string): ReviewSessionRecord[] {
    return this.store
      .all<SessionRow>(
        `${SESSION_SELECT} WHERE s.user_id = ? AND s.repo_id = ? AND s.pr_number = ? AND s.id != ?
         ORDER BY s.created_at DESC, s.rowid DESC`,
        userId,
        repoId,
        prNumber,
        excludeId,
      )
      .map(rowToSession);
  }

  /**
   * Moves rather than copies, so ids stay stable. Resolved and dismissed threads stay with the
   * commit where they were dealt with.
   */
  moveOpenWork(userId: string, fromSessionIds: string[], toSessionId: string): number {
    if (fromSessionIds.length === 0) {
      return 0;
    }
    return this.store.transaction(() => {
      const moved = this.store.run(
        `UPDATE threads SET session_id = ? WHERE user_id = ? AND status = 'open' AND session_id IN (${placeholders(fromSessionIds)})`,
        toSessionId,
        userId,
        ...fromSessionIds,
      ).changes;
      this.store.run(
        `UPDATE tours SET session_id = ? WHERE user_id = ? AND session_id IN (${placeholders(fromSessionIds)})`,
        toSessionId,
        userId,
        ...fromSessionIds,
      );
      return moved;
    });
  }

  startReview(userId: string, sessionId: string, note: string): void {
    this.store.run(
      'UPDATE sessions SET review_started_at = ?, review_finished_at = NULL, review_note = ? WHERE id = ? AND user_id = ?',
      new Date().toISOString(),
      note,
      sessionId,
      userId,
    );
  }

  finishReview(userId: string, sessionId: string): void {
    this.store.run(
      'UPDATE sessions SET review_finished_at = ? WHERE id = ? AND user_id = ? AND review_started_at IS NOT NULL',
      new Date().toISOString(),
      sessionId,
      userId,
    );
  }

  createThread(input: {
    userId: string;
    sessionId: string;
    filePath: string;
    side: CommentSide;
    startLine: number;
    endLine: number;
    body: string;
    author: CommentAuthor;
    anchorContent?: string | null;
    kind?: CommentKind;
  }): CommentThread {
    const threadId = randomUUID();
    const commentId = randomUUID();
    const now = new Date().toISOString();
    this.store.transaction(() => {
      this.store.run(
        `INSERT INTO threads (id, user_id, session_id, file_path, side, start_line, end_line, anchor_content, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        threadId,
        input.userId,
        input.sessionId,
        input.filePath,
        input.side,
        input.startLine,
        input.endLine,
        input.anchorContent ?? null,
        now,
        now,
      );
      this.insertComment(input.userId, commentId, threadId, input.author, input.body, input.kind ?? 'review', now);
    });
    return this.getThread(input.userId, threadId)!;
  }

  private insertComment(
    userId: string,
    id: string,
    threadId: string,
    author: CommentAuthor,
    body: string,
    kind: CommentKind,
    createdAt: string,
  ): void {
    this.store.run(
      `INSERT INTO comments (id, user_id, thread_id, author_name, author_type, body, kind, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      id,
      userId,
      threadId,
      author.name,
      author.type,
      body,
      kind,
      createdAt,
    );
  }

  private commentsFor(threadIds: string[]): Map<string, Comment[]> {
    const map = new Map<string, Comment[]>();
    if (threadIds.length === 0) {
      return map;
    }
    const rows = this.store.all<CommentRow>(
      `SELECT * FROM comments WHERE thread_id IN (${placeholders(threadIds)}) ORDER BY created_at ASC, rowid ASC`,
      ...threadIds,
    );
    for (const row of rows) {
      const list = map.get(row.thread_id) ?? [];
      list.push(rowToComment(row));
      map.set(row.thread_id, list);
    }
    return map;
  }

  getThread(userId: string, idOrPrefix: string): CommentThread | null {
    const id = this.resolveId('threads', userId, idOrPrefix);
    if (!id) {
      return null;
    }
    const row = this.store.get<ThreadRow>('SELECT * FROM threads WHERE id = ? AND user_id = ?', id, userId);
    if (!row) {
      return null;
    }
    return rowToThread(row, this.commentsFor([row.id]).get(row.id) ?? []);
  }

  threadsForSession(userId: string, sessionId: string, status?: ThreadStatus): CommentThread[] {
    const rows = status
      ? this.store.all<ThreadRow>(
          'SELECT * FROM threads WHERE user_id = ? AND session_id = ? AND status = ? ORDER BY created_at ASC, rowid ASC',
          userId,
          sessionId,
          status,
        )
      : this.store.all<ThreadRow>(
          'SELECT * FROM threads WHERE user_id = ? AND session_id = ? ORDER BY created_at ASC, rowid ASC',
          userId,
          sessionId,
        );
    const comments = this.commentsFor(rows.map(row => row.id));
    return rows.map(row => rowToThread(row, comments.get(row.id) ?? []));
  }

  addReply(userId: string, threadId: string, body: string, author: CommentAuthor, kind: CommentKind = 'review'): Comment {
    const id = randomUUID();
    const now = new Date().toISOString();
    this.store.transaction(() => {
      this.insertComment(userId, id, threadId, author, body, kind, now);
      // A person answering a finding reopens it; an agent's note on it does not.
      if (author.type === 'user') {
        this.store.run("UPDATE threads SET status = 'open', updated_at = ? WHERE id = ? AND user_id = ?", now, threadId, userId);
      } else {
        this.store.run('UPDATE threads SET updated_at = ? WHERE id = ? AND user_id = ?', now, threadId, userId);
      }
    });
    return rowToComment(this.store.get<CommentRow>('SELECT * FROM comments WHERE id = ?', id)!);
  }

  updateThreadStatus(userId: string, threadId: string, status: ThreadStatus, summary?: string, summaryAuthor?: CommentAuthor): void {
    const now = new Date().toISOString();
    this.store.transaction(() => {
      this.store.run('UPDATE threads SET status = ?, updated_at = ? WHERE id = ? AND user_id = ?', status, now, threadId, userId);
      if (summary && summaryAuthor) {
        this.insertComment(userId, randomUUID(), threadId, summaryAuthor, summary, 'review', now);
      }
    });
  }

  updateThreadLines(userId: string, threadId: string, startLine: number, endLine: number): void {
    this.store.run('UPDATE threads SET start_line = ?, end_line = ? WHERE id = ? AND user_id = ?', startLine, endLine, threadId, userId);
  }

  updateThreadPath(userId: string, threadId: string, filePath: string): void {
    this.store.run('UPDATE threads SET file_path = ? WHERE id = ? AND user_id = ?', filePath, threadId, userId);
  }

  deleteThread(userId: string, threadId: string): void {
    this.store.run('DELETE FROM threads WHERE id = ? AND user_id = ?', threadId, userId);
  }

  deleteThreadsForSession(userId: string, sessionId: string): void {
    this.store.run('DELETE FROM threads WHERE session_id = ? AND user_id = ?', sessionId, userId);
  }

  /** The comment, with the thread and session it sits in, if it is this user's. */
  findComment(userId: string, idOrPrefix: string): { comment: Comment; threadId: string; sessionId: string } | null {
    const id = this.resolveId('comments', userId, idOrPrefix);
    if (!id) {
      return null;
    }
    const row = this.store.get<CommentRow & { session_id: string }>(
      `SELECT c.*, t.session_id FROM comments c JOIN threads t ON t.id = c.thread_id
        WHERE c.id = ? AND c.user_id = ?`,
      id,
      userId,
    );
    return row ? { comment: rowToComment(row), threadId: row.thread_id, sessionId: row.session_id } : null;
  }

  editComment(userId: string, commentId: string, body: string): void {
    this.store.run('UPDATE comments SET body = ? WHERE id = ? AND user_id = ?', body, commentId, userId);
  }

  /** The last comment of a thread takes the thread with it: an empty thread renders as nothing. */
  deleteComment(userId: string, commentId: string): void {
    const row = this.store.get<{ thread_id: string }>('SELECT thread_id FROM comments WHERE id = ? AND user_id = ?', commentId, userId);
    if (!row) {
      return;
    }
    this.store.transaction(() => {
      this.store.run('DELETE FROM comments WHERE id = ? AND user_id = ?', commentId, userId);
      const remaining = this.store.get<{ n: number }>('SELECT COUNT(*) AS n FROM comments WHERE thread_id = ?', row.thread_id);
      if (remaining?.n === 0) {
        this.store.run('DELETE FROM threads WHERE id = ? AND user_id = ?', row.thread_id, userId);
      }
    });
  }

  createTour(userId: string, sessionId: string, topic: string, body: string): Tour {
    const id = randomUUID();
    this.store.run(
      'INSERT INTO tours (id, user_id, session_id, topic, body, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      id,
      userId,
      sessionId,
      topic,
      body,
      new Date().toISOString(),
    );
    return this.getTour(userId, id)!;
  }

  getTour(userId: string, idOrPrefix: string): Tour | null {
    const id = this.resolveId('tours', userId, idOrPrefix);
    if (!id) {
      return null;
    }
    const row = this.store.get<TourRow>('SELECT * FROM tours WHERE id = ? AND user_id = ?', id, userId);
    if (!row) {
      return null;
    }
    const steps = this.store.all<TourStepRow>('SELECT * FROM tour_steps WHERE tour_id = ? ORDER BY sort_order ASC', row.id);
    return this.rowToTour(row, steps.map(rowToStep));
  }

  private rowToTour(row: TourRow, steps: TourStep[]): Tour {
    return {
      id: row.id,
      sessionId: row.session_id,
      topic: row.topic,
      body: row.body,
      status: isTourStatus(row.status) ? row.status : 'ready',
      createdAt: row.created_at,
      steps,
    };
  }

  toursForSession(userId: string, sessionId: string): Tour[] {
    const rows = this.store.all<TourRow>(
      'SELECT * FROM tours WHERE user_id = ? AND session_id = ? ORDER BY created_at ASC, rowid ASC',
      userId,
      sessionId,
    );
    if (rows.length === 0) {
      return [];
    }
    const steps = this.store.all<TourStepRow>(
      `SELECT * FROM tour_steps WHERE tour_id IN (${placeholders(rows)}) ORDER BY sort_order ASC`,
      ...rows.map(row => row.id),
    );
    return rows.map(row => this.rowToTour(row, steps.filter(step => step.tour_id === row.id).map(rowToStep)));
  }

  addTourStep(
    userId: string,
    tourId: string,
    step: { filePath: string; startLine: number; endLine: number; body: string; annotation: string },
  ): TourStep {
    const id = randomUUID();
    const max = this.store.get<{ n: number }>('SELECT COALESCE(MAX(sort_order), 0) AS n FROM tour_steps WHERE tour_id = ?', tourId);
    this.store.run(
      `INSERT INTO tour_steps (id, user_id, tour_id, sort_order, file_path, start_line, end_line, body, annotation, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id,
      userId,
      tourId,
      (max?.n ?? 0) + 1,
      step.filePath,
      step.startLine,
      step.endLine,
      step.body,
      step.annotation,
      new Date().toISOString(),
    );
    return rowToStep(this.store.get<TourStepRow>('SELECT * FROM tour_steps WHERE id = ?', id)!);
  }

  updateTourStatus(userId: string, tourId: string, status: TourStatus): void {
    this.store.run('UPDATE tours SET status = ? WHERE id = ? AND user_id = ?', status, tourId, userId);
  }

  deleteTour(userId: string, tourId: string): void {
    this.store.run('DELETE FROM tours WHERE id = ? AND user_id = ?', tourId, userId);
  }
}
