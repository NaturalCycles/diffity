export interface SinceLastWait {
  /** Findings that went to the forge while the agent was waiting. */
  submitted: number;
}

/**
 * What changed while the agent was parked, which it is otherwise never told.
 *
 * Submitting a review does not wake anything — the queue only carries what the reader asks — so an
 * agent can answer a question about a finding that has already gone out and word it as though it
 * had not. Carried on the way back rather than raised as an event: it is worth knowing, not worth
 * interrupting for.
 */
export function sinceLastWait(submittedAt: (string | null)[], seenAt: string | null): SinceLastWait {
  const after = seenAt ?? '';

  return {
    submitted: submittedAt.filter((at): at is string => !!at && at > after).length,
  };
}

export function describeSince(since: SinceLastWait): string | null {
  if (since.submitted === 0) {
    return null;
  }
  const count = `${since.submitted} finding${since.submitted === 1 ? '' : 's'}`;

  return `${count} went to the pull request while you were waiting. Amending one now leaves the `
    + 'forge showing the old wording.';
}
