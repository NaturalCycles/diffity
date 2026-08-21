import { execFileSync } from 'node:child_process';
import { exec } from './exec.js';
import type { PrBase } from './types.js';

const PR_URL_REGEX = /(?:https?:\/\/)?github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/;

export function isGitHubPrUrl(value: string): boolean {
  return PR_URL_REGEX.test(value);
}

export function parseGitHubPrUrl(url: string): { owner: string; repo: string; number: number } | null {
  const match = url.match(PR_URL_REGEX);
  if (!match) {
    return null;
  }

  return {
    owner: match[1],
    repo: match[2].replace(/\.git$/, ''),
    number: parseInt(match[3], 10),
  };
}

export function checkoutPr(prNumber: number): void {
  try {
    exec(`gh pr checkout ${prNumber}`);
    return;
  } catch (err) {
    // A merged pull request usually has its branch deleted, and gh can only check out a branch.
    // The forge keeps refs/pull/<n>/head either way, which is what a review actually needs.
    try {
      execFileSync('git', ['fetch', 'origin', `refs/pull/${prNumber}/head`], { stdio: 'pipe' });
      execFileSync('git', ['checkout', '--detach', 'FETCH_HEAD'], { stdio: 'pipe' });
    } catch {
      throw err;
    }
  }
}

export function parsePrBase(json: string): PrBase {
  const { baseRefName, baseRefOid } = JSON.parse(json) as {
    baseRefName?: string;
    baseRefOid?: string;
  };

  if (!baseRefName || !baseRefOid) {
    throw new Error('Pull request response is missing baseRefName or baseRefOid');
  }

  return { name: baseRefName, oid: baseRefOid };
}

export function getPrBase(prNumber: number): PrBase {
  return parsePrBase(exec(`gh pr view ${prNumber} --json baseRefName,baseRefOid`));
}
