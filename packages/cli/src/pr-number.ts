import { InvalidArgumentError } from 'commander';

/** What `--pr` accepts: the number of the pull request a checkout cannot name itself. */
export function pullRequestNumber(value: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new InvalidArgumentError('A pull request number is a positive integer.');
  }
  return parsed;
}
