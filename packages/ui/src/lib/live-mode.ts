import type { Comment } from '../components/comments/types';

/**
 * Live mode is remembered per checkout and branch — the same thing that identifies a review. Left on
 * while working on your own change, it must not still be on when the next tab is somebody else's
 * pull request.
 */
export function liveModeKey(repoRoot: string, branch: string): string {
  return `diffity:live:${repoRoot}:${branch}`;
}

export function readLiveMode(storage: Storage, repoRoot: string, branch: string): boolean {
  return storage.getItem(liveModeKey(repoRoot, branch)) === 'on';
}

export function writeLiveMode(storage: Storage, repoRoot: string, branch: string, on: boolean): void {
  if (on) {
    storage.setItem(liveModeKey(repoRoot, branch), 'on');
    return;
  }
  storage.removeItem(liveModeKey(repoRoot, branch));
}

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
