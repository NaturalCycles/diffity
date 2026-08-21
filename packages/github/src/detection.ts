import { exec, execSilent } from './exec.js';
import { getReviews } from './reviews.js';
import type { GitHubRemote, GitHubDetails } from './types.js';

export function getRemote(): { owner: string; repo: string } | null {
  try {
    const url = exec('git remote get-url origin');
    const match = url.match(/github\.com[:/]([^/]+)\/([^/.]+)/);
    if (match) {
      return { owner: match[1], repo: match[2] };
    }
    return null;
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

  const pr = getPr(prNumber);
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
      viewerLogin = exec('gh api user --jq .login') || null;
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
function getPr(prNumber?: number): PrData | null {
  try {
    const target = prNumber ? `${prNumber} ` : '';
    const json = exec(`gh pr view ${target}--json number,title,url,headRefOid,createdAt,author,body`);
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
    const raw = exec(
      `gh api repos/${owner}/${repo}/pulls/${prNumber}/comments --jq 'length'`,
    );
    return parseInt(raw, 10) || 0;
  } catch {
    return 0;
  }
}
