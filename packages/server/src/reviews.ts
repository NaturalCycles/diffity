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
import type { Db, Queryable } from './db.js';

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

/** `%` and `_` in a prefix would otherwise widen the match. */
function likePrefix(prefix: string): string {
  return prefix.replaceAll('\\', '\\\\').replaceAll('%', '\\%').replaceAll('_', '\\_') + '%';
}

/**
 * Every read and write here names the user it is for, and a row belonging to anyone else is
 * treated exactly like one that does not exist.
 */
export class Reviews {
  constructor(private readonly db: Db) {}

  /** A full id, or the 8-character prefix the CLI's ids accept, among this user's rows only. */
  private async resolveId(table: 'sessions' | 'threads' | 'comments' | 'tours', userId: string, idOrPrefix: string): Promise<string | null> {
    const exact = await this.db.one<{ id: string }>(`SELECT id FROM ${table} WHERE id = $1 AND user_id = $2`, [idOrPrefix, userId]);
    if (exact) {
      return exact.id;
    }
    if (idOrPrefix.length < 8) {
      return null;
    }
    const matches = await this.db.query<{ id: string }>(
      `SELECT id FROM ${table} WHERE user_id = $1 AND id LIKE $2 ESCAPE '\\' LIMIT 2`,
      [userId, likePrefix(idOrPrefix)],
    );
    if (matches.length > 1) {
      throw new AmbiguousIdError(`${idOrPrefix} matches more than one ${table.replace(/s$/, '')}; give more of the id`);
    }
    return matches[0]?.id ?? null;
  }

  async repoId(owner: string, name: string): Promise<number> {
    await this.db.query('INSERT INTO repos (owner, name) VALUES ($1, $2) ON CONFLICT (owner, name) DO NOTHING', [owner, name]);
    return (await this.db.one<{ id: number }>('SELECT id FROM repos WHERE owner = $1 AND name = $2', [owner, name]))!.id;
  }

  async findOrCreateSession(input: {
    userId: string;
    owner: string;
    repo: string;
    kind: SessionKind;
    prNumber: number | null;
    prMeta: PrMeta | null;
    baseSha: string;
    headSha: string;
  }): Promise<{ session: ReviewSessionRecord; created: boolean }> {
    const repoId = await this.repoId(input.owner, input.repo);
    const inserted = await this.db.one<{ id: string }>(
      `INSERT INTO sessions (id, user_id, repo_id, kind, pr_number, pr_meta, base_sha, head_sha, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       ON CONFLICT (user_id, repo_id, base_sha, head_sha) DO NOTHING RETURNING id`,
      [
        randomUUID(),
        input.userId,
        repoId,
        input.kind,
        input.prNumber,
        input.prMeta ? JSON.stringify(input.prMeta) : null,
        input.baseSha,
        input.headSha,
        new Date().toISOString(),
      ],
    );
    if (inserted) {
      return { session: (await this.getSession(input.userId, inserted.id))!, created: true };
    }
    const existing = (await this.db.one<{ id: string }>(
      'SELECT id FROM sessions WHERE user_id = $1 AND repo_id = $2 AND base_sha = $3 AND head_sha = $4',
      [input.userId, repoId, input.baseSha, input.headSha],
    ))!;
    if (input.prMeta) {
      await this.db.query('UPDATE sessions SET pr_meta = $1, pr_number = COALESCE(pr_number, $2) WHERE id = $3', [
        JSON.stringify(input.prMeta),
        input.prNumber,
        existing.id,
      ]);
    }
    return { session: (await this.getSession(input.userId, existing.id))!, created: false };
  }

  async getSession(userId: string, idOrPrefix: string): Promise<ReviewSessionRecord | null> {
    const id = await this.resolveId('sessions', userId, idOrPrefix);
    if (!id) {
      return null;
    }
    const row = await this.db.one<SessionRow>(`${SESSION_SELECT} WHERE s.id = $1 AND s.user_id = $2`, [id, userId]);
    return row ? rowToSession(row) : null;
  }

  async listSessions(userId: string, filter: { owner?: string; repo?: string; limit?: number } = {}): Promise<ReviewSessionRecord[]> {
    const byRepo = filter.owner && filter.repo;
    const rows = await this.db.query<SessionRow>(
      `${SESSION_SELECT} WHERE s.user_id = $1
       ${byRepo ? 'AND lower(r.owner) = lower($3) AND lower(r.name) = lower($4)' : ''}
       ORDER BY s.created_at DESC, s.seq DESC LIMIT $2`,
      byRepo ? [userId, filter.limit ?? 100, filter.owner, filter.repo] : [userId, filter.limit ?? 100],
    );
    return rows.map(rowToSession);
  }

  /** Earlier sessions of the same pull request, newest first — where carried work comes from. */
  async priorPrSessions(userId: string, repoId: number, prNumber: number, excludeId: string): Promise<ReviewSessionRecord[]> {
    const rows = await this.db.query<SessionRow>(
      `${SESSION_SELECT} WHERE s.user_id = $1 AND s.repo_id = $2 AND s.pr_number = $3 AND s.id != $4
       ORDER BY s.created_at DESC, s.seq DESC`,
      [userId, repoId, prNumber, excludeId],
    );
    return rows.map(rowToSession);
  }

  /**
   * Moves rather than copies, so ids stay stable. Resolved and dismissed threads stay with the
   * commit where they were dealt with.
   */
  async moveOpenWork(userId: string, fromSessionIds: string[], toSessionId: string): Promise<number> {
    if (fromSessionIds.length === 0) {
      return 0;
    }
    return this.db.transaction(async tx => {
      const moved = await tx.query(
        `UPDATE threads SET session_id = $1 WHERE user_id = $2 AND status = 'open' AND session_id = ANY($3) RETURNING id`,
        [toSessionId, userId, fromSessionIds],
      );
      await tx.query('UPDATE tours SET session_id = $1 WHERE user_id = $2 AND session_id = ANY($3)', [
        toSessionId,
        userId,
        fromSessionIds,
      ]);
      return moved.length;
    });
  }

  async startReview(userId: string, sessionId: string, note: string): Promise<void> {
    await this.db.query(
      'UPDATE sessions SET review_started_at = $1, review_finished_at = NULL, review_note = $2 WHERE id = $3 AND user_id = $4',
      [new Date().toISOString(), note, sessionId, userId],
    );
  }

  async finishReview(userId: string, sessionId: string): Promise<void> {
    await this.db.query(
      'UPDATE sessions SET review_finished_at = $1 WHERE id = $2 AND user_id = $3 AND review_started_at IS NOT NULL',
      [new Date().toISOString(), sessionId, userId],
    );
  }

  async createThread(input: {
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
    githubCommentId?: number | null;
  }): Promise<CommentThread> {
    const threadId = randomUUID();
    const now = new Date().toISOString();
    await this.db.transaction(async tx => {
      await tx.query(
        `INSERT INTO threads (id, user_id, session_id, file_path, side, start_line, end_line, anchor_content, github_comment_id, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $10)`,
        [
          threadId,
          input.userId,
          input.sessionId,
          input.filePath,
          input.side,
          input.startLine,
          input.endLine,
          input.anchorContent ?? null,
          input.githubCommentId ?? null,
          now,
        ],
      );
      await insertComment(tx, input.userId, threadId, input.author, input.body, input.kind ?? 'review', now);
    });
    return (await this.getThread(input.userId, threadId))!;
  }

  private async commentsFor(threadIds: string[]): Promise<Map<string, Comment[]>> {
    const map = new Map<string, Comment[]>();
    if (threadIds.length === 0) {
      return map;
    }
    const rows = await this.db.query<CommentRow>('SELECT * FROM comments WHERE thread_id = ANY($1) ORDER BY seq ASC', [threadIds]);
    for (const row of rows) {
      const list = map.get(row.thread_id) ?? [];
      list.push(rowToComment(row));
      map.set(row.thread_id, list);
    }
    return map;
  }

  async getThread(userId: string, idOrPrefix: string): Promise<CommentThread | null> {
    const id = await this.resolveId('threads', userId, idOrPrefix);
    if (!id) {
      return null;
    }
    const row = await this.db.one<ThreadRow>('SELECT * FROM threads WHERE id = $1 AND user_id = $2', [id, userId]);
    if (!row) {
      return null;
    }
    return rowToThread(row, (await this.commentsFor([row.id])).get(row.id) ?? []);
  }

  async threadsForSession(userId: string, sessionId: string, status?: ThreadStatus): Promise<CommentThread[]> {
    const rows = status
      ? await this.db.query<ThreadRow>(
          'SELECT * FROM threads WHERE user_id = $1 AND session_id = $2 AND status = $3 ORDER BY seq ASC',
          [userId, sessionId, status],
        )
      : await this.db.query<ThreadRow>('SELECT * FROM threads WHERE user_id = $1 AND session_id = $2 ORDER BY seq ASC', [
          userId,
          sessionId,
        ]);
    const comments = await this.commentsFor(rows.map(row => row.id));
    return rows.map(row => rowToThread(row, comments.get(row.id) ?? []));
  }

  async addReply(userId: string, threadId: string, body: string, author: CommentAuthor, kind: CommentKind = 'review'): Promise<Comment> {
    const now = new Date().toISOString();
    const id = await this.db.transaction(async tx => {
      const commentId = await insertComment(tx, userId, threadId, author, body, kind, now);
      // A person answering a finding reopens it; an agent's note on it does not.
      await tx.query(
        `UPDATE threads SET updated_at = $1${author.type === 'user' ? ", status = 'open'" : ''} WHERE id = $2 AND user_id = $3`,
        [now, threadId, userId],
      );
      return commentId;
    });
    return rowToComment((await this.db.one<CommentRow>('SELECT * FROM comments WHERE id = $1', [id]))!);
  }

  async updateThreadStatus(
    userId: string,
    threadId: string,
    status: ThreadStatus,
    summary?: string,
    summaryAuthor?: CommentAuthor,
  ): Promise<void> {
    const now = new Date().toISOString();
    await this.db.transaction(async tx => {
      const updated = await tx.one('UPDATE threads SET status = $1, updated_at = $2 WHERE id = $3 AND user_id = $4 RETURNING id', [
        status,
        now,
        threadId,
        userId,
      ]);
      if (updated && summary && summaryAuthor) {
        await insertComment(tx, userId, threadId, summaryAuthor, summary, 'review', now);
      }
    });
  }

  async updateThreadLines(userId: string, threadId: string, startLine: number, endLine: number): Promise<void> {
    await this.db.query('UPDATE threads SET start_line = $1, end_line = $2 WHERE id = $3 AND user_id = $4', [
      startLine,
      endLine,
      threadId,
      userId,
    ]);
  }

  async updateThreadPath(userId: string, threadId: string, filePath: string): Promise<void> {
    await this.db.query('UPDATE threads SET file_path = $1 WHERE id = $2 AND user_id = $3', [filePath, threadId, userId]);
  }

  /** The ids among these whose findings are already on the pull request. */
  async threadsOnTheForge(userId: string, threadIds: string[]): Promise<Set<string>> {
    if (threadIds.length === 0) {
      return new Set();
    }
    const rows = await this.db.query<{ id: string }>(
      `SELECT id FROM threads WHERE user_id = $1 AND id = ANY($2)
         AND (submitted_at IS NOT NULL OR github_comment_id IS NOT NULL)`,
      [userId, threadIds],
    );
    return new Set(rows.map(row => row.id));
  }

  async markThreadsSubmitted(
    userId: string,
    sent: { threadId: string; body?: string; githubCommentId?: number }[],
    submittedIn: { reviewUrl: string | null; headSha: string },
  ): Promise<void> {
    const now = new Date().toISOString();
    for (const entry of sent) {
      await this.db.query(
        `UPDATE threads SET submitted_at = $1, submitted_review_url = $2, submitted_head_sha = $3,
           submitted_body = COALESCE($4, submitted_body), github_comment_id = COALESCE($5, github_comment_id)
         WHERE id = $6 AND user_id = $7`,
        [now, submittedIn.reviewUrl, submittedIn.headSha, entry.body ?? null, entry.githubCommentId ?? null, entry.threadId, userId],
      );
    }
  }

  async setThreadForgeComment(userId: string, threadId: string, githubCommentId: number): Promise<void> {
    await this.db.query('UPDATE threads SET github_comment_id = $1 WHERE id = $2 AND user_id = $3', [githubCommentId, threadId, userId]);
  }

  async deleteThread(userId: string, threadId: string): Promise<void> {
    await this.db.query('DELETE FROM threads WHERE id = $1 AND user_id = $2', [threadId, userId]);
  }

  async deleteThreadsForSession(userId: string, sessionId: string): Promise<void> {
    await this.db.query('DELETE FROM threads WHERE session_id = $1 AND user_id = $2', [sessionId, userId]);
  }

  /** The comment, with the thread and session it sits in, if it is this user's. */
  async findComment(userId: string, idOrPrefix: string): Promise<{ comment: Comment; threadId: string; sessionId: string } | null> {
    const id = await this.resolveId('comments', userId, idOrPrefix);
    if (!id) {
      return null;
    }
    const row = await this.db.one<CommentRow & { session_id: string }>(
      `SELECT c.*, t.session_id FROM comments c JOIN threads t ON t.id = c.thread_id
        WHERE c.id = $1 AND c.user_id = $2`,
      [id, userId],
    );
    return row ? { comment: rowToComment(row), threadId: row.thread_id, sessionId: row.session_id } : null;
  }

  async editComment(userId: string, commentId: string, body: string): Promise<void> {
    await this.db.query('UPDATE comments SET body = $1 WHERE id = $2 AND user_id = $3', [body, commentId, userId]);
  }

  /** The last comment of a thread takes the thread with it: an empty thread renders as nothing. */
  async deleteComment(userId: string, commentId: string): Promise<void> {
    await this.db.transaction(async tx => {
      const deleted = await tx.one<{ thread_id: string }>(
        'DELETE FROM comments WHERE id = $1 AND user_id = $2 RETURNING thread_id',
        [commentId, userId],
      );
      if (deleted) {
        await tx.query(
          'DELETE FROM threads WHERE id = $1 AND user_id = $2 AND NOT EXISTS (SELECT 1 FROM comments WHERE thread_id = $1)',
          [deleted.thread_id, userId],
        );
      }
    });
  }

  async createTour(userId: string, sessionId: string, topic: string, body: string): Promise<Tour> {
    const id = randomUUID();
    await this.db.query('INSERT INTO tours (id, user_id, session_id, topic, body, created_at) VALUES ($1, $2, $3, $4, $5, $6)', [
      id,
      userId,
      sessionId,
      topic,
      body,
      new Date().toISOString(),
    ]);
    return (await this.getTour(userId, id))!;
  }

  async getTour(userId: string, idOrPrefix: string): Promise<Tour | null> {
    const id = await this.resolveId('tours', userId, idOrPrefix);
    if (!id) {
      return null;
    }
    const row = await this.db.one<TourRow>('SELECT * FROM tours WHERE id = $1 AND user_id = $2', [id, userId]);
    if (!row) {
      return null;
    }
    const steps = await this.db.query<TourStepRow>('SELECT * FROM tour_steps WHERE tour_id = $1 ORDER BY sort_order ASC', [row.id]);
    return rowToTour(row, steps.map(rowToStep));
  }

  async toursForSession(userId: string, sessionId: string): Promise<Tour[]> {
    const rows = await this.db.query<TourRow>('SELECT * FROM tours WHERE user_id = $1 AND session_id = $2 ORDER BY seq ASC', [
      userId,
      sessionId,
    ]);
    if (rows.length === 0) {
      return [];
    }
    const steps = await this.db.query<TourStepRow>('SELECT * FROM tour_steps WHERE tour_id = ANY($1) ORDER BY sort_order ASC', [
      rows.map(row => row.id),
    ]);
    return rows.map(row => rowToTour(row, steps.filter(step => step.tour_id === row.id).map(rowToStep)));
  }

  async addTourStep(
    userId: string,
    tourId: string,
    step: { filePath: string; startLine: number; endLine: number; body: string; annotation: string },
  ): Promise<TourStep> {
    const row = await this.db.one<TourStepRow>(
      `INSERT INTO tour_steps (id, user_id, tour_id, sort_order, file_path, start_line, end_line, body, annotation, created_at)
       VALUES ($1, $2, $3, (SELECT COALESCE(MAX(sort_order), 0) + 1 FROM tour_steps WHERE tour_id = $3), $4, $5, $6, $7, $8, $9)
       RETURNING *`,
      [randomUUID(), userId, tourId, step.filePath, step.startLine, step.endLine, step.body, step.annotation, new Date().toISOString()],
    );
    return rowToStep(row!);
  }

  async updateTourStatus(userId: string, tourId: string, status: TourStatus): Promise<void> {
    await this.db.query('UPDATE tours SET status = $1 WHERE id = $2 AND user_id = $3', [status, tourId, userId]);
  }

  async deleteTour(userId: string, tourId: string): Promise<void> {
    await this.db.query('DELETE FROM tours WHERE id = $1 AND user_id = $2', [tourId, userId]);
  }
}

async function insertComment(
  tx: Queryable,
  userId: string,
  threadId: string,
  author: CommentAuthor,
  body: string,
  kind: CommentKind,
  createdAt: string,
): Promise<string> {
  const id = randomUUID();
  await tx.query(
    `INSERT INTO comments (id, user_id, thread_id, author_name, author_type, body, kind, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [id, userId, threadId, author.name, author.type, body, kind, createdAt],
  );
  return id;
}

function rowToTour(row: TourRow, steps: TourStep[]): Tour {
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
