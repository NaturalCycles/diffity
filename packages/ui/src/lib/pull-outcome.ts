export interface PullCounts {
  pulled: number;
  skipped: number;
  resolved: number;
  /** The forge could not be asked which threads are resolved, as opposed to answering "none". */
  resolutionUnavailable?: boolean;
  /** Comments on lines this checkout does not have, so no thread was made for them. */
  unmapped?: number;
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

export function pullOutcome({ pulled, skipped, resolved, resolutionUnavailable, unmapped = 0 }: PullCounts): PullOutcome {
  const parts: string[] = [];
  if (pulled > 0) parts.push(`Pulled ${count(pulled, 'comment')}`);
  if (resolved > 0) parts.push(`${count(resolved, 'finding')} resolved on the pull request`);

  if (resolutionUnavailable) {
    parts.push('could not read which are resolved');
  }
  if (unmapped > 0) {
    parts.push(`${count(unmapped, 'comment')} on lines this checkout does not have`);
  }

  if (parts.length === 0) {
    return {
      kind: 'info',
      message: skipped > 0 ? 'Nothing new — every comment is already here' : 'Nothing to pull',
      refresh: false,
    };
  }

  return {
    kind: resolutionUnavailable || (pulled === 0 && resolved === 0) ? 'info' : 'success',
    message: parts.join(', '),
    refresh: pulled > 0 || resolved > 0,
  };
}
