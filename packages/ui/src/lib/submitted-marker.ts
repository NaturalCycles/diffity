const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function clockTime(date: Date): string {
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

function daysApart(from: Date, to: Date): number {
  const startOf = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  return Math.round((startOf(to) - startOf(from)) / 86_400_000);
}

/**
 * A time of day rather than "19h ago": the question this answers is whether the author has seen it
 * yet, which is a question about when it landed, not about how long ago that was.
 */
export function submittedLabel(submittedAt: string | null | undefined, now = new Date()): string | null {
  if (!submittedAt) return null;

  const date = new Date(submittedAt);
  if (Number.isNaN(date.getTime())) return null;

  const days = daysApart(date, now);
  if (days === 0) return `Posted to GitHub ${clockTime(date)}`;
  if (days === 1) return `Posted to GitHub yesterday ${clockTime(date)}`;

  const day = `${date.getDate()} ${MONTHS[date.getMonth()]}`;
  const withYear = date.getFullYear() === now.getFullYear() ? day : `${day} ${date.getFullYear()}`;
  return `Posted to GitHub ${withYear} ${clockTime(date)}`;
}

/**
 * Resolving here does not resolve there. Only worth saying about a finding that was posted — for
 * anything else, local is the only place it could be resolved.
 */
export function localResolveNotice(
  submittedAt: string | null | undefined,
  action: 'resolved' | 'dismissed' = 'resolved',
): string | null {
  if (!submittedAt) return null;
  return `${action === 'resolved' ? 'Resolved' : 'Dismissed'} here only — the thread on the pull request stays open`;
}
