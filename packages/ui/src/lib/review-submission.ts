import type { CommentKind, CommentThread } from '../components/comments/types';
import { GENERAL_THREAD_FILE_PATH, isThreadResolved } from '../components/comments/types';
import type { PrCommentPayload, ReviewEvent } from './api';

export function isReviewComment(comment: { kind?: CommentKind }): boolean {
  return (comment.kind ?? 'review') === 'review';
}

/**
 * Only the finding travels. Everything said after it was said to work out what the finding should
 * say, so the way to get an answer onto the pull request is to amend the finding, not to ship the
 * conversation that produced it.
 */
export function findingOf(thread: CommentThread): string | undefined {
  return thread.comments.find(isReviewComment)?.body;
}

export function threadToPayload(thread: CommentThread): PrCommentPayload {
  const finding = findingOf(thread);

  return {
    threadId: thread.id,
    filePath: thread.filePath,
    side: thread.side === 'old' ? 'LEFT' : 'RIGHT',
    startLine: thread.startLine !== thread.endLine ? thread.startLine : null,
    endLine: thread.endLine,
    body: finding ?? '',
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
    .map(findingOf)
    .filter(body => !!body)
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
