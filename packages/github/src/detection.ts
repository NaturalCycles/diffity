import { exec, execSilent, ghAsync, ghSucceeds } from './exec.js';
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

// Remembered only when true: a missing or unauthenticated gh is retried on the next ask, so
// logging in does not require a restart — but the ready answer cannot change while we live.
let cliKnownReady = false;

async function cliReady(): Promise<boolean> {
  if (cliKnownReady) {
    return true;
  }
  cliKnownReady = (await ghSucceeds(['--version'])) && (await ghSucceeds(['auth', 'status']));
  return cliKnownReady;
}

export async function fetchDetails(owner: string, repo: string, prNumber?: number): Promise<GitHubDetails | null> {
  if (!(await cliReady())) {
    return null;
  }

  const pr = await getPr(owner, repo, prNumber);
  if (!pr) {
    return null;
  }

  const [commentCount, reviews, viewerLogin] = await Promise.all([
    getReviewCommentCount(owner, repo, pr.number),
    getReviews(owner, repo, pr.number),
    getViewerLogin(),
  ]);

  return {
    prNumber: pr.number,
    prTitle: pr.title,
    prUrl: pr.url,
    prCreatedAt: pr.createdAt,
    headSha: pr.headSha,
    commentCount,
    prAuthor: pr.authorLogin ?? '',
    viewerDidAuthor: !!pr.authorLogin && pr.authorLogin === viewerLogin,
    prBody: pr.body,
    reviews,
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
// authenticated user cannot change while the process lives, so it is asked for once — the
// promise is what is remembered, so concurrent first asks share one subprocess.
let viewerLogin: Promise<string | null> | undefined;

function getViewerLogin(): Promise<string | null> {
  viewerLogin ??= ghAsync(['api', 'user', '--jq', '.login']).then(
    login => login || null,
    () => null,
  );
  return viewerLogin;
}

/**
 * Without a number, gh resolves the pull request from the current branch — which fails on a
 * detached checkout, and a merged pull request has no branch left to check out.
 */
async function getPr(owner: string, repo: string, prNumber?: number): Promise<PrData | null> {
  try {
    // Pinned to the repository the local remote names. Left to itself, gh resolves a fork's
    // parent, which is how a review can be aimed at the wrong repository entirely.
    const args = ['pr', 'view'];
    if (prNumber) {
      args.push(String(prNumber));
    }
    args.push('--repo', `${owner}/${repo}`, '--json', 'number,title,url,headRefOid,createdAt,author,body');
    const json = await ghAsync(args);
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

async function getReviewCommentCount(owner: string, repo: string, prNumber: number): Promise<number> {
  try {
    const raw = await ghAsync([
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
