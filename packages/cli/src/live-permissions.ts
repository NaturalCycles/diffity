/**
 * Reviewing is not editing. A pull request somebody else wrote can be asked about, and the review
 * comments on it rewritten, but never its code — so this is derived from who wrote it rather than
 * from a setting somebody can leave switched on.
 *
 * Advisory rather than enforced: the agent holds the file handles either way. What this buys is
 * that the agent is told, per request, instead of having to remember to ask.
 */
export function mayChangeCode(pullRequest: { viewerDidAuthor?: boolean } | null): boolean {
  if (!pullRequest) {
    return true;
  }
  return pullRequest.viewerDidAuthor === true;
}
