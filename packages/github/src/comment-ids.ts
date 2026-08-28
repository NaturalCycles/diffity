export interface SentComment {
  threadId?: string;
  path: string;
  body: string;
  endLine: number;
}

export interface CreatedComment {
  id: number;
  path: string;
  body: string;
  /** The comment's end line as the forge anchored it, or null when it reports none. */
  line: number | null;
}

/**
 * Which created comment answers which sent finding. Matched on path, line and body within the one
 * review that was just posted, consuming each created comment at most once — so two identical
 * findings on one line, the only pair the key cannot separate, pair up in order instead of both
 * claiming the first id.
 */
export function matchCreatedComments(
  sent: SentComment[],
  created: CreatedComment[],
): { threadId: string; githubCommentId: number }[] {
  const unclaimed = [...created];
  const matches: { threadId: string; githubCommentId: number }[] = [];

  for (const comment of sent) {
    if (!comment.threadId) {
      continue;
    }
    const index = unclaimed.findIndex(c =>
      c.path === comment.path
      && c.body === comment.body
      && (c.line == null || c.line === comment.endLine),
    );
    if (index === -1) {
      continue;
    }
    matches.push({ threadId: comment.threadId, githubCommentId: unclaimed[index].id });
    unclaimed.splice(index, 1);
  }

  return matches;
}
