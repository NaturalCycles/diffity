export interface PullCounts {
  pulled: number;
  skipped: number;
  resolved: number;
}

export interface PullOutcome {
  kind: 'success' | 'info';
  message: string;
  /** Whether anything changed here, and the page has to be re-read to show it. */
  refresh: boolean;
}

function count(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? '' : 's'}`;
}

export function pullOutcome({ pulled, skipped, resolved }: PullCounts): PullOutcome {
  const parts: string[] = [];
  if (pulled > 0) parts.push(`Pulled ${count(pulled, 'comment')}`);
  if (resolved > 0) parts.push(`${count(resolved, 'finding')} resolved on the pull request`);

  if (parts.length === 0) {
    return {
      kind: 'info',
      message: skipped > 0 ? 'Nothing new — every comment is already here' : 'Nothing to pull',
      refresh: false,
    };
  }

  return { kind: 'success', message: parts.join(', '), refresh: true };
}
