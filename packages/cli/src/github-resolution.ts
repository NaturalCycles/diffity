export interface RemoteThreadState {
  filePath: string;
  side: 'old' | 'new';
  /** Null once GitHub marks the thread outdated, so it cannot be part of the identity. */
  endLine: number | null;
  body: string;
  isResolved: boolean;
}

interface LocalThreadLike {
  id: string;
  filePath: string;
  side: string;
  endLine: number;
  status: string;
  submittedAt?: string | null;
  comments: { body: string }[];
}

/**
 * Which local threads the forge now considers settled.
 *
 * Only threads we sent are considered: a thread that was never posted cannot have been resolved by
 * the author, and matching one to a remote thread that merely looks like it would resolve a finding
 * nobody has seen.
 *
 * Matched on file and wording rather than on line. GitHub nulls a thread's line once it goes
 * outdated, which is the state most resolved threads are in by the time anyone looks, so a line in
 * the key means the sync quietly does nothing on exactly the threads it exists for. Two findings
 * with identical wording in one file would both resolve together; a missed resolution leaves a
 * thread open, which is the cheaper way to be wrong.
 */
export function threadsResolvedRemotely(
  local: LocalThreadLike[],
  remote: RemoteThreadState[],
): string[] {
  const resolvedRemotely = remote.filter(state => state.isResolved);

  return local
    .filter(thread => thread.submittedAt && thread.status === 'open')
    .filter(thread =>
      resolvedRemotely.some(
        state =>
          state.filePath === thread.filePath
          && state.side === thread.side
          && thread.comments.some(comment => comment.body === state.body),
      ),
    )
    .map(thread => thread.id);
}
