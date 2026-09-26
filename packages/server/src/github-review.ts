import { parseDiff } from '@diffity/parser';
import type { CommentThread, PrComment } from '@diffity/api';
import type { RemoteThreadState, ReviewComment, ReviewCommentPayload } from './github.js';

export interface CommentableSides {
  RIGHT: Set<number>;
  LEFT: Set<number>;
}

/**
 * The lines a review comment may be attached to, per file. GitHub rejects a comment outside the
 * pull request's diff, and one rejection fails the whole review, so they are found beforehand.
 */
export function commentableLines(patch: string): Map<string, CommentableSides> {
  const byFile = new Map<string, CommentableSides>();
  if (!patch.trim()) {
    return byFile;
  }
  for (const file of parseDiff(patch).files) {
    const sides: CommentableSides = { RIGHT: new Set(), LEFT: new Set() };
    for (const hunk of file.hunks) {
      for (const line of hunk.lines) {
        if (line.newLineNumber !== null) {
          sides.RIGHT.add(line.newLineNumber);
        }
        if (line.oldLineNumber !== null) {
          sides.LEFT.add(line.oldLineNumber);
        }
      }
    }
    byFile.set(file.status === 'deleted' ? file.oldPath : file.newPath, sides);
  }
  return byFile;
}

export function toReviewPayload(comment: PrComment): ReviewCommentPayload {
  const payload: ReviewCommentPayload = { path: comment.filePath, side: comment.side, line: comment.endLine, body: comment.body };
  if (comment.startLine && comment.startLine !== comment.endLine) {
    payload.start_line = comment.startLine;
    payload.start_side = comment.side;
  }
  return payload;
}

/** Line endings and trailing space differ between what was sent and what comes back. */
function sameWording(one: string, other: string): boolean {
  return one.replace(/\r\n/g, '\n').trim() === other.replace(/\r\n/g, '\n').trim();
}

/**
 * Whether this finding is already on the pull request. A finding diffity knows it sent (or pulled)
 * is never sent again, however reworded, since GitHub cannot update it in place. Without a record,
 * the same wording on the same line from the same account is the evidence left. A line alone says
 * nothing: it collects comments over rounds.
 */
export function isAlreadyCommented(
  existing: ReviewComment[],
  comment: PrComment,
  posted: { threadIds: ReadonlySet<string>; viewerLogin: string | null },
): boolean {
  if (comment.threadId && posted.threadIds.has(comment.threadId)) {
    return true;
  }
  return existing.some(one =>
    one.path === comment.filePath
    && one.line === comment.endLine
    && one.side === comment.side
    && sameWording(one.body, comment.body)
    && (!posted.viewerLogin || one.login === posted.viewerLogin),
  );
}

export interface SentComment {
  threadId: string;
  path: string;
  body: string;
  endLine: number;
}

/**
 * Which created comment answers which sent finding, each created comment claimed at most once, so
 * two identical findings on one line pair up in order.
 */
export function matchCreatedComments(sent: SentComment[], created: ReviewComment[]): { threadId: string; githubCommentId: number }[] {
  const unclaimed = [...created];
  const matches: { threadId: string; githubCommentId: number }[] = [];
  for (const comment of sent) {
    const index = unclaimed.findIndex(c =>
      c.path === comment.path && c.body === comment.body && (c.line == null || c.line === comment.endLine),
    );
    if (index === -1) {
      continue;
    }
    matches.push({ threadId: comment.threadId, githubCommentId: unclaimed[index].id });
    unclaimed.splice(index, 1);
  }
  return matches;
}

export interface PulledThread {
  filePath: string;
  side: 'old' | 'new';
  startLine: number;
  endLine: number;
  firstCommentId: number;
  comments: { body: string; authorName: string; authorType: 'user' | 'agent' }[];
}

/** Review comments as threads: each root on a line, with its replies. Outdated roots have no line. */
export function groupPulledThreads(comments: ReviewComment[]): PulledThread[] {
  const replies = new Map<number, ReviewComment[]>();
  for (const comment of comments) {
    if (comment.inReplyToId) {
      replies.set(comment.inReplyToId, [...(replies.get(comment.inReplyToId) ?? []), comment]);
    }
  }
  return comments
    .filter(comment => comment.line !== null && !comment.inReplyToId)
    .map(root => ({
      filePath: root.path,
      side: root.side === 'LEFT' ? 'old' as const : 'new' as const,
      startLine: root.startLine ?? root.line!,
      endLine: root.line!,
      firstCommentId: root.id,
      comments: [root, ...(replies.get(root.id) ?? [])].map(c => ({
        body: c.body,
        authorName: c.login,
        authorType: c.isBot ? 'agent' as const : 'user' as const,
      })),
    }));
}

/**
 * The thread a pulled one already exists as: by GitHub's comment id when recorded, else by
 * position and first wording.
 */
export function existingThreadFor(local: CommentThread[], remote: PulledThread): CommentThread | undefined {
  const byId = local.find(thread => thread.githubCommentId != null && thread.githubCommentId === remote.firstCommentId);
  if (byId) {
    return byId;
  }
  const first = remote.comments[0];
  return local.find(thread =>
    thread.filePath === remote.filePath
    && thread.side === remote.side
    && thread.startLine === remote.startLine
    && thread.endLine === remote.endLine
    && thread.comments.some(comment => comment.body === first.body),
  );
}

/**
 * The open threads that were sent and that GitHub now shows resolved. Matched by comment id when
 * both sides have it, else by file, side and the wording that was sent (not the line: GitHub nulls
 * it once a thread goes outdated). A missed match leaves a thread open, the cheaper mistake.
 */
export function threadsResolvedRemotely(local: CommentThread[], remote: RemoteThreadState[]): string[] {
  const resolved = remote.filter(state => state.isResolved);
  return local
    .filter(thread => thread.submittedAt && thread.status === 'open')
    .filter(thread => resolved.some(state => {
      if (thread.githubCommentId != null && state.firstCommentId != null) {
        return thread.githubCommentId === state.firstCommentId;
      }
      const sent = thread.submittedBody ? [thread.submittedBody] : thread.comments.map(comment => comment.body);
      return state.filePath === thread.filePath && state.side === thread.side && sent.includes(state.body);
    }))
    .map(thread => thread.id);
}
