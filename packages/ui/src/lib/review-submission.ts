import type { CommentThread } from '../components/comments/types';
import { GENERAL_THREAD_FILE_PATH, isThreadResolved } from '../components/comments/types';
import type { PrCommentPayload } from './api';

/**
 * A thread's replies are part of the same finding, so they are folded into the one comment
 * GitHub will hold — a review comment has no thread of its own until it exists.
 */
export function threadToPayload(thread: CommentThread): PrCommentPayload {
  const [first, ...replies] = thread.comments;
  const body = replies.length
    ? [first.body, ...replies.map(reply => `**${reply.author.name}:** ${reply.body}`)].join('\n\n---\n\n')
    : first.body;

  return {
    filePath: thread.filePath,
    side: thread.side === 'old' ? 'LEFT' : 'RIGHT',
    startLine: thread.startLine !== thread.endLine ? thread.startLine : null,
    endLine: thread.endLine,
    body,
  };
}

export function isSubmittable(thread: CommentThread): boolean {
  return !isThreadResolved(thread) && thread.filePath !== GENERAL_THREAD_FILE_PATH;
}

export function isGeneral(thread: CommentThread): boolean {
  return !isThreadResolved(thread) && thread.filePath === GENERAL_THREAD_FILE_PATH;
}

/**
 * General comments belong to no line, so they seed the review's summary rather than being
 * dropped, which is what happened when only line comments could be pushed.
 */
export function summaryFromGeneralThreads(threads: CommentThread[]): string {
  return threads
    .filter(isGeneral)
    .flatMap(thread => thread.comments.map(comment => comment.body))
    .join('\n\n');
}
