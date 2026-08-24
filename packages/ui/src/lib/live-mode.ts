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

export function isAside(comment: Comment): boolean {
  return comment.kind === 'aside';
}
