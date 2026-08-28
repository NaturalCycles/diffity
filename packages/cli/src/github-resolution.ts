import type { RemoteThreadState } from '@diffity/github';

export type { RemoteThreadState } from '@diffity/github';

interface LocalThreadLike {
  id: string;
  filePath: string;
  side: string;
  endLine: number;
  status: string;
  submittedAt?: string | null;
  submittedBody?: string | null;
  githubCommentId?: number | null;
  comments: { body: string }[];
}

/**
 * Which local threads the forge now considers settled.
 *
 * Only threads we sent are considered: a thread that was never posted cannot have been resolved by
 * the author, and matching one to a remote thread that merely looks like it would resolve a finding
 * nobody has seen.
 *
 * When both sides know the forge's comment id, that is the identity and nothing else is consulted.
 * Threads sent before the id was recorded fall back to file and wording — not line, because GitHub
 * nulls a thread's line once it goes outdated, which is the state most resolved threads are in by
 * the time anyone looks. Two id-less findings with identical wording in one file would both resolve
 * together; a missed resolution leaves a thread open, which is the cheaper way to be wrong.
 *
 * The wording compared is the one that was sent, not the one held now: amending rewrites the body
 * here and leaves the forge showing the old text. Threads sent before that was recorded fall back
 * to their current bodies, which is what they had at the time anyway.
 */
export function threadsResolvedRemotely(
  local: LocalThreadLike[],
  remote: RemoteThreadState[],
): string[] {
  const resolvedRemotely = remote.filter(state => state.isResolved);

  return local
    .filter(thread => thread.submittedAt && thread.status === 'open')
    .filter(thread => resolvedRemotely.some(state => sameThread(thread, state)))
    .map(thread => thread.id);
}

function sameThread(thread: LocalThreadLike, state: RemoteThreadState): boolean {
  if (thread.githubCommentId != null && state.firstCommentId != null) {
    return thread.githubCommentId === state.firstCommentId;
  }

  return (
    state.filePath === thread.filePath
    && state.side === thread.side
    && wordingSent(thread).includes(state.body)
  );
}

function wordingSent(thread: LocalThreadLike): string[] {
  return thread.submittedBody ? [thread.submittedBody] : thread.comments.map(comment => comment.body);
}
