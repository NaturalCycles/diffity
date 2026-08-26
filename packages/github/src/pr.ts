import { execFileSync } from 'node:child_process';
import { gh } from './exec.js';
import type { PrComment, PulledThread, ReviewResult, ReviewSubmission } from './types.js';
import { commentableLines, isAlreadyCommented } from './comment-targets.js';


interface ExistingComment {
  path: string;
  line: number;
  side: string;
  body: string;
}

export function getComments(owner: string, repo: string, prNumber: number): ExistingComment[] {
  try {
    const json = gh([
      'api',
      `repos/${owner}/${repo}/pulls/${prNumber}/comments`,
      '--paginate',
    ]);
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

export interface RemoteThreadState {
  filePath: string;
  side: 'old' | 'new';
  endLine: number | null;
  body: string;
  isResolved: boolean;
}

const REVIEW_THREADS_QUERY = `query($owner:String!,$repo:String!,$number:Int!){
  repository(owner:$owner,name:$repo){
    pullRequest(number:$number){
      reviewThreads(first:100){
        nodes{
          isResolved
          line
          originalLine
          diffSide
          path
          comments(first:1){ nodes{ body } }
        }
      }
    }
  }
}`;

/**
 * Whether the author has ticked a thread off. REST does not carry it — resolution lives on
 * `PullRequestReviewThread`, which is GraphQL only — so this is a second call rather than a field
 * on the comments we already fetch.
 *
 * One page. A review with more than a hundred threads reports the first hundred, which is wrong in
 * a way that only under-reports: a thread we do not see is left open here, never wrongly closed.
 *
 * `null` means the question could not be asked — an expired token, a rate limit, a schema change —
 * as opposed to `[]`, which means it was asked and nothing came back. The two look identical to a
 * reader otherwise, and this whole change exists because a thread was quiet about what it knew.
 */
export function pullThreadState(owner: string, repo: string, prNumber: number): RemoteThreadState[] | null {
  try {
    const json = gh([
      'api', 'graphql',
      '-f', `query=${REVIEW_THREADS_QUERY}`,
      '-F', `owner=${owner}`,
      '-F', `repo=${repo}`,
      '-F', `number=${prNumber}`,
    ]);
    if (!json) return null;

    const data = JSON.parse(json) as {
      data?: { repository?: { pullRequest?: { reviewThreads?: { nodes?: RawReviewThread[] } } } };
    };
    const nodes = data.data?.repository?.pullRequest?.reviewThreads?.nodes ?? [];

    return nodes.flatMap(node => {
      const body = node.comments?.nodes?.[0]?.body;
      if (!body || !node.path) return [];
      return [{
        filePath: node.path,
        side: node.diffSide === 'LEFT' ? 'old' as const : 'new' as const,
        // Null once the thread goes outdated, which is why it is not part of the identity.
        endLine: node.line ?? node.originalLine ?? null,
        body,
        isResolved: !!node.isResolved,
      }];
    });
  } catch {
    return null;
  }
}

interface RawReviewThread {
  isResolved: boolean;
  line: number | null;
  originalLine: number | null;
  diffSide: string;
  path: string;
  comments?: { nodes?: { body: string }[] };
}

export function pullComments(owner: string, repo: string, prNumber: number): PulledThread[] {
  try {
    const json = gh([
      'api',
      `repos/${owner}/${repo}/pulls/${prNumber}/comments`,
      '--paginate',
    ]);
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
  const commentable = commentableLines(getPatch(owner, repo, prNumber));
  const existing = getComments(owner, repo, prNumber);

  const errors: string[] = [];
  const comments: ReviewCommentPayload[] = [];
  const sentThreadIds: string[] = [];
  let skipped = 0;

  for (const comment of submission.comments) {
    const sides = commentable.get(comment.filePath);

    if (!sides) {
      errors.push(`${comment.filePath} — not in PR diff (push your changes first)`);
      continue;
    }
    // The whole review is one request, so a single unpostable line would reject all of it.
    if (!sides[comment.side].has(comment.endLine)) {
      errors.push(
        `${comment.filePath}:${comment.endLine} — not in the diff diffity fetched for this pull request, so the forge will not take a comment there. If the line is really in the diff, the local branch and the pull request have drifted`,
      );
      continue;
    }
    if (isAlreadyCommented(existing, comment)) {
      skipped++;
      continue;
    }
    comments.push(toReviewComment(comment));
    if (comment.threadId) {
      sentThreadIds.push(comment.threadId);
    }
  }

  const dropped = errors.length;
  const body = submission.body.trim();

  if (comments.length === 0 && !body && submission.event === 'COMMENT') {
    return { submitted: 0, submittedThreadIds: [], skipped, failed: dropped, errors, reviewUrl: null };
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
      submittedThreadIds: sentThreadIds,
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
      submittedThreadIds: [],
      skipped,
      failed: dropped + comments.length,
      errors: [...errors, ghLine ? ghLine.trim() : 'GitHub rejected the review'],
      reviewUrl: null,
    };
  }
}

/**
 * The pull request's diff as the review API sees it: one section per file, base to head.
 *
 * Not `--patch`, which is the commit series in mbox form — one section per commit, hunks measured
 * against that commit's parent, and files under whatever path they had at the time. A file touched
 * by several commits appears several times, and only the last one survives being collected, so
 * whether a comment was allowed depended on which commit happened to touch that line last.
 */
function getPatch(owner: string, repo: string, prNumber: number): string {
  try {
    return execFileSync('gh', ['pr', 'diff', String(prNumber), '--repo', `${owner}/${repo}`], {
      encoding: 'utf-8',
      stdio: 'pipe',
      maxBuffer: 50 * 1024 * 1024,
    });
  } catch {
    return '';
  }
}
