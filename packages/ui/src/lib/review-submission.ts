import type { CommentKind, CommentThread } from '../components/comments/types';
import { GENERAL_THREAD_FILE_PATH, isThreadResolved } from '../components/comments/types';
import type { PrCommentPayload, ReviewEvent } from './api';

/**
 * A thread's replies are part of the same finding, so they are folded into the one comment
 * GitHub will hold — a review comment has no thread of its own until it exists.
 */
export function isReviewComment(comment: { kind?: CommentKind }): boolean {
  return (comment.kind ?? 'review') === 'review';
}

export function threadToPayload(thread: CommentThread): PrCommentPayload {
  // An aside is a conversation with the agent about the review, not part of it. Sending one would
  // put the whole exchange on the pull request.
  const [first, ...replies] = thread.comments.filter(isReviewComment);
  const body = replies.length
    ? [first.body, ...replies.map(reply => `**${reply.author.name}:** ${reply.body}`)].join('\n\n---\n\n')
    : first.body;

  return {
    threadId: thread.id,
    filePath: thread.filePath,
    side: thread.side === 'old' ? 'LEFT' : 'RIGHT',
    startLine: thread.startLine !== thread.endLine ? thread.startLine : null,
    endLine: thread.endLine,
    body,
  };
}

export function isSubmittable(thread: CommentThread): boolean {
  return (
    !isThreadResolved(thread)
    && thread.filePath !== GENERAL_THREAD_FILE_PATH
    && thread.comments.some(isReviewComment)
  );
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

/**
 * A plain comment needs something to say. A verdict does not: an approval with nothing attached
 * is a normal thing to send, and the forge accepts it.
 */
export function canSubmitReview(input: {
  event: ReviewEvent;
  comments: number;
  summary: string;
  reviewInProgress?: boolean;
}): boolean {
  if (input.reviewInProgress) {
    return false;
  }

  if (input.event !== 'COMMENT') {
    return true;
  }

  return input.comments > 0 || input.summary.trim().length > 0;
}

/** Already on the pull request, so resending has to be asked for rather than assumed. */
export function wasSubmitted(thread: CommentThread): boolean {
  return !!thread.submittedAt;
}
