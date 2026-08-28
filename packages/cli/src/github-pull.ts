import type { PulledThread } from '@diffity/github';
import type { Thread } from './threads.js';

/**
 * The local thread a pulled remote thread already exists as, if any. The forge's comment id is the
 * identity when this side has recorded one; threads pulled or sent before ids were recorded are
 * still recognised by their position and first wording.
 */
export function existingThreadFor(local: Thread[], remote: PulledThread): Thread | undefined {
  const byId = local.find(thread => thread.githubCommentId != null && thread.githubCommentId === remote.firstCommentId);
  if (byId) {
    return byId;
  }

  const firstComment = remote.comments[0];
  return local.find(thread =>
    thread.filePath === remote.filePath
    && thread.side === remote.side
    && thread.startLine === remote.startLine
    && thread.endLine === remote.endLine
    && thread.comments.some(comment => comment.body === firstComment.body),
  );
}
