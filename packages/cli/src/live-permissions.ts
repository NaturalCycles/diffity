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

export type SessionPurpose = 'work' | 'review';

export function normalisePurpose(value: unknown): SessionPurpose | undefined {
  return value === 'work' || value === 'review' ? value : undefined;
}

/**
 * Authorship is a proxy for whose work this is, and it stops being one the moment work is handed
 * over: take over a colleague's branch and the pull request still says they opened it.
 *
 * The agent launching diffity knows which it is doing, so it can say — once, at launch, for that
 * server only. Not a setting: there is nothing to leave switched on, because it dies with the
 * process. Unsaid still means derived from authorship.
 */
export function resolveMayChangeCode(
  purpose: SessionPurpose | undefined,
  pullRequest: { viewerDidAuthor?: boolean } | null,
): boolean {
  const said = normalisePurpose(purpose);
  if (said) {
    return said === 'work';
  }
  return mayChangeCode(pullRequest);
}
