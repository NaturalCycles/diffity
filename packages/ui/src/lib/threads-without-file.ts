import type { CommentThread } from '../components/comments/types';
import { GENERAL_THREAD_FILE_PATH, isThreadResolved } from '../components/comments/types';

/**
 * Findings whose file is not in the diff at all.
 *
 * A thread is rendered inside the block for its file, so one naming a file that is not there is
 * rendered by nothing — it does not look wrong, it is simply absent, which is the worst way for a
 * finding to be lost. Renames are followed when work carries forward, so what reaches here is a
 * file that was deleted, or moved in a way git did not report as a rename.
 *
 * Resolved threads are left out: they have been dealt with, and the file going away is no reason to
 * ask about them again.
 */
export function threadsWithoutFile(threads: CommentThread[], diffPaths: Iterable<string>): CommentThread[] {
  const present = new Set(diffPaths);

  return threads.filter(
    thread =>
      thread.filePath !== GENERAL_THREAD_FILE_PATH
      && !isThreadResolved(thread)
      && !present.has(thread.filePath),
  );
}
