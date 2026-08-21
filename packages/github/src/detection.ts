import { exec, execSilent, gh } from './exec.js';
import { parseRemoteUrl } from './remote.js';
import { getReviews } from './reviews.js';
import type { GitHubRemote, GitHubDetails } from './types.js';

export function getRemote(): { owner: string; repo: string } | null {
  try {
    return parseRemoteUrl(exec('git remote get-url origin'));
  } catch {
    return null;
  }
}

export function isCliInstalled(): boolean {
  return execSilent('gh --version');
}

export function isAuthenticated(): boolean {
  return execSilent('gh auth status');
}

export function detectRemote(): GitHubRemote | null {
  const remote = getRemote();
  if (!remote) {
    return null;
  }
  return remote;
}

export function fetchDetails(owner: string, repo: string, prNumber?: number): GitHubDetails | null {
  if (!isCliInstalled() || !isAuthenticated()) {
    return null;
  }

  const pr = getPr(owner, repo, prNumber);
  if (!pr) {
    return null;
  }

  const commentCount = getReviewCommentCount(owner, repo, pr.number);

  return {
    prNumber: pr.number,
    prTitle: pr.title,
    prUrl: pr.url,
    prCreatedAt: pr.createdAt,
    headSha: pr.headSha,
    commentCount,
    viewerDidAuthor: !!pr.authorLogin && pr.authorLogin === getViewerLogin(),
    prBody: pr.body,
    reviews: getReviews(owner, repo, pr.number),
  };
}

interface PrData {
  number: number;
  title: string;
  url: string;
  headSha: string;
  createdAt: string;
  authorLogin: string | null;
  body: string;
}

// gh has no `viewerDidAuthor` field, so authorship is settled by comparing logins. The
// authenticated user cannot change while the process lives, so it is asked for once.
let viewerLogin: string | null | undefined;

function getViewerLogin(): string | null {
  if (viewerLogin === undefined) {
    try {
      viewerLogin = gh(['api', 'user', '--jq', '.login']) || null;
    } catch {
      viewerLogin = null;
    }
  }
  return viewerLogin;
}

/**
 * Without a number, gh resolves the pull request from the current branch — which fails on a
 * detached checkout, and a merged pull request has no branch left to check out.
 */
function getPr(owner: string, repo: string, prNumber?: number): PrData | null {
  try {
    // Pinned to the repository the local remote names. Left to itself, gh resolves a fork's
    // parent, which is how a review can be aimed at the wrong repository entirely.
    const args = ['pr', 'view'];
    if (prNumber) {
      args.push(String(prNumber));
    }
    args.push('--repo', `${owner}/${repo}`, '--json', 'number,title,url,headRefOid,createdAt,author,body');
    const json = gh(args);
    const data = JSON.parse(json);
    if (data.number && data.url && data.headRefOid) {
      return {
        number: data.number,
        title: data.title,
        url: data.url,
        headSha: data.headRefOid,
        createdAt: data.createdAt,
        authorLogin: data.author?.login ?? null,
        body: data.body ?? '',
      };
    }
    return null;
  } catch {
    return null;
  }
}

function getReviewCommentCount(owner: string, repo: string, prNumber: number): number {
  try {
    const raw = gh([
      'api',
      `repos/${owner}/${repo}/pulls/${prNumber}/comments`,
      '--jq',
      'length',
    ]);
    return parseInt(raw, 10) || 0;
  } catch {
    return 0;
  }
}
