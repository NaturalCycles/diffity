import { execFileSync, execSync } from 'node:child_process';
import { exec } from './exec.js';
import type { PrComment, PulledThread, ReviewResult, ReviewSubmission } from './types.js';

export function getFiles(owner: string, repo: string, prNumber: number): Set<string> {
  try {
    const raw = exec(
      `gh api repos/${owner}/${repo}/pulls/${prNumber}/files --jq '.[].filename'`,
    );
    return new Set(raw.split('\n').filter(Boolean));
  } catch {
    return new Set();
  }
}

interface ExistingComment {
  path: string;
  line: number;
  side: string;
  body: string;
}

export function getComments(owner: string, repo: string, prNumber: number): ExistingComment[] {
  try {
    const json = execSync(
      `gh api repos/${owner}/${repo}/pulls/${prNumber}/comments --paginate`,
      { encoding: 'utf-8', stdio: 'pipe', maxBuffer: 10 * 1024 * 1024 },
    ).trim();
    if (!json) {
      return [];
    }
    const data = JSON.parse(json);
    if (!Array.isArray(data)) {
      return [];
    }
    return data.map((c: { path: string; line: number; side: string; body: string }) => ({
      path: c.path,
      line: c.line,
      side: c.side,
      body: c.body,
    }));
  } catch {
    return [];
  }
}

export function getCommentCount(owner: string, repo: string, prNumber: number): number {
  return getComments(owner, repo, prNumber).length;
}

interface GitHubCommentRaw {
  id: number;
  path: string;
  line: number;
  start_line: number | null;
  side: string;
  body: string;
  in_reply_to_id: number | null;
  user: { login: string; type: string };
  created_at: string;
}

export function pullComments(owner: string, repo: string, prNumber: number): PulledThread[] {
  try {
    const json = execSync(
      `gh api repos/${owner}/${repo}/pulls/${prNumber}/comments --paginate`,
      { encoding: 'utf-8', stdio: 'pipe', maxBuffer: 10 * 1024 * 1024 },
    ).trim();
    if (!json) {
      return [];
    }
    const data = JSON.parse(json) as GitHubCommentRaw[];
    if (!Array.isArray(data)) {
      return [];
    }

    const rootComments = data.filter(c => c.line !== null && !c.in_reply_to_id);
    const repliesByRoot = new Map<number, GitHubCommentRaw[]>();
    for (const c of data) {
      if (c.in_reply_to_id) {
        const list = repliesByRoot.get(c.in_reply_to_id) ?? [];
        list.push(c);
        repliesByRoot.set(c.in_reply_to_id, list);
      }
    }

    return rootComments.map(root => {
      const replies = repliesByRoot.get(root.id) ?? [];
      const allComments = [root, ...replies];
      return {
        filePath: root.path,
        side: root.side === 'LEFT' ? 'old' as const : 'new' as const,
        startLine: root.start_line ?? root.line,
        endLine: root.line,
        comments: allComments.map(c => ({
          body: c.body,
          authorName: c.user.login,
          authorType: c.user.type === 'Bot' ? 'agent' as const : 'user' as const,
          createdAt: c.created_at,
        })),
      };
    });
  } catch {
    return [];
  }
}

function isDuplicate(existing: ExistingComment[], comment: PrComment): boolean {
  return existing.some(e =>
    e.path === comment.filePath &&
    e.line === comment.endLine &&
    e.side === comment.side &&
    e.body === comment.body,
  );
}

interface ReviewCommentPayload {
  path: string;
  side: string;
  line: number;
  body: string;
  start_line?: number;
  start_side?: string;
}

function toReviewComment(comment: PrComment): ReviewCommentPayload {
  const payload: ReviewCommentPayload = {
    path: comment.filePath,
    side: comment.side,
    line: comment.endLine,
    body: comment.body,
  };

  if (comment.startLine && comment.startLine !== comment.endLine) {
    payload.start_line = comment.startLine;
    payload.start_side = comment.side;
  }

  return payload;
}

/**
 * Submits one review holding every comment, rather than posting them one at a time: the author
 * gets a single notification, a partial failure cannot leave half a review on the pull request,
 * and the summary body has somewhere to live.
 *
 * GitHub does not deduplicate, so comments already on the pull request are dropped first.
 */
export function createReview(
  owner: string,
  repo: string,
  prNumber: number,
  headSha: string,
  submission: ReviewSubmission,
): ReviewResult {
  const prFiles = getFiles(owner, repo, prNumber);
  const existing = getComments(owner, repo, prNumber);

  const errors: string[] = [];
  const comments: ReviewCommentPayload[] = [];
  let skipped = 0;

  for (const comment of submission.comments) {
    if (!prFiles.has(comment.filePath)) {
      errors.push(`${comment.filePath} — not in PR diff (push your changes first)`);
      continue;
    }
    if (isDuplicate(existing, comment)) {
      skipped++;
      continue;
    }
    comments.push(toReviewComment(comment));
  }

  const dropped = errors.length;
  const body = submission.body.trim();

  if (comments.length === 0 && !body && submission.event === 'COMMENT') {
    return { submitted: 0, skipped, failed: dropped, errors, reviewUrl: null };
  }

  try {
    const raw = execFileSync(
      'gh',
      ['api', `repos/${owner}/${repo}/pulls/${prNumber}/reviews`, '--method', 'POST', '--input', '-'],
      {
        input: JSON.stringify({ commit_id: headSha, event: submission.event, body, comments }),
        encoding: 'utf-8',
        stdio: 'pipe',
      },
    );
    const review = JSON.parse(raw) as { html_url?: string };
    return {
      submitted: comments.length,
      skipped,
      failed: dropped,
      errors,
      reviewUrl: review.html_url ?? null,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const ghLine = msg.split('\n').find(line => line.includes('gh:'));
    return {
      submitted: 0,
      skipped,
      failed: dropped + comments.length,
      errors: [...errors, ghLine ? ghLine.trim() : 'GitHub rejected the review'],
      reviewUrl: null,
    };
  }
}
