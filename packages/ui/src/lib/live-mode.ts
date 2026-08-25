import type { Comment } from '../components/comments/types';

export type RequestState = 'waiting' | 'working' | 'answered';

/**
 * Where a request has got to, so a wait of half a minute does not look like nothing happening.
 * Null means the comment never asked for anything.
 */
export function requestStateOf(comment: Comment): RequestState | null {
  if (!comment.liveRequestedAt) {
    return null;
  }
  if (comment.liveAnsweredAt) {
    return 'answered';
  }
  return comment.liveClaimedAt ? 'working' : 'waiting';
}

/** What the reader asked for, for a chip that has to say more than "asked". */
export function intentOf(comment: Comment): 'ask' | 'act' {
  return comment.liveIntent === 'act' ? 'act' : 'ask';
}

export function isAside(comment: Comment): boolean {
  return comment.kind === 'aside';
}

interface LiveStatusLike {
  enabled: boolean;
  mayChangeCode: boolean;
}

/** Asking is available wherever live mode is, whether or not anyone is listening — it queues. */
export function canAskAgent(status: LiveStatusLike | undefined, reviewsEnabled: boolean): boolean {
  return !!status?.enabled && reviewsEnabled;
}

/**
 * Acting is not. Reviewing is not editing, so a pull request somebody else wrote gets Ask and no
 * Act — offered and then refused would be worse than not offered, since a button that is there is
 * a promise.
 */
export function canActOnCode(status: LiveStatusLike | undefined, reviewsEnabled: boolean): boolean {
  return canAskAgent(status, reviewsEnabled) && !!status?.mayChangeCode;
}
