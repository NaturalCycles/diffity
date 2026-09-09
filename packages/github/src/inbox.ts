import { ghAsync } from './exec.js';

/** Which pull request, by the coordinates every gh call takes. */
export interface PrRef {
  owner: string;
  repo: string;
  number: number;
}

export const PR_STATES = ['OPEN', 'CLOSED', 'MERGED'] as const;
export type PrState = (typeof PR_STATES)[number];

/** One CI check on a head, whatever the forge calls it: a check run or a commit status. */
export interface PrCheck {
  name: string;
  status: 'success' | 'failure' | 'pending' | 'skipped' | 'neutral';
}

export interface PrFile {
  path: string;
  additions: number;
  deletions: number;
}

/** What CI amounts to for a head, taken as a whole. */
export type CiState = 'passing' | 'failing' | 'running' | 'none';

/** Beyond this a pull request's file list says nothing more that a prompt or an alert needs. */
export const MAX_SNAPSHOT_FILES = 300;

/** What one `gh pr view` says about a pull request, as far as the inbox cares. */
export interface PrSnapshot extends PrRef {
  title: string;
  url: string;
  /** The description as the author wrote it; empty when there is none. */
  body: string;
  author: string;
  isBot: boolean;
  isDraft: boolean;
  state: PrState;
  headSha: string;
  baseRef: string;
  additions: number;
  deletions: number;
  changedFiles: number;
  createdAt: string;
  updatedAt: string;
  /** What CI says about this head; empty when nothing has reported, or when gh cannot say. */
  checks: PrCheck[];
  files: PrFile[];
}

/** The open pull requests asking the authenticated user for a review. */
export async function searchReviewRequested(): Promise<PrRef[]> {
  const json = await ghAsync([
    'search', 'prs',
    '--review-requested=@me',
    '--state=open',
    '--json', 'repository,number',
    '--limit', '100',
  ]);
  return parseReviewRequested(json);
}

export function parseReviewRequested(json: string): PrRef[] {
  const data: unknown = JSON.parse(json);
  if (!Array.isArray(data)) {
    return [];
  }
  const refs: PrRef[] = [];
  for (const item of data) {
    const nameWithOwner = item?.repository?.nameWithOwner;
    const number = item?.number;
    if (typeof nameWithOwner !== 'string' || typeof number !== 'number') {
      continue;
    }
    const [owner, repo] = nameWithOwner.split('/');
    if (owner && repo) {
      refs.push({ owner, repo, number });
    }
  }
  return refs;
}

/** Null when gh cannot answer — no access, no such pull request, no network. */
export async function viewPr(ref: PrRef): Promise<PrSnapshot | null> {
  try {
    const json = await ghAsync([
      'pr', 'view', String(ref.number),
      '--repo', `${ref.owner}/${ref.repo}`,
      '--json', 'number,title,url,body,author,isDraft,state,headRefOid,baseRefName,additions,deletions,changedFiles,createdAt,updatedAt,statusCheckRollup,files',
    ]);
    return parsePrSnapshot(ref, json);
  } catch {
    return null;
  }
}

export function parsePrSnapshot(ref: PrRef, json: string): PrSnapshot | null {
  const data = JSON.parse(json);
  if (typeof data?.headRefOid !== 'string' || typeof data?.url !== 'string' || !isPrState(data?.state)) {
    return null;
  }
  return {
    owner: ref.owner,
    repo: ref.repo,
    number: ref.number,
    title: String(data.title ?? ''),
    url: data.url,
    body: String(data.body ?? ''),
    author: String(data.author?.login ?? ''),
    isBot: data.author?.is_bot === true,
    isDraft: data.isDraft === true,
    state: data.state,
    headSha: data.headRefOid,
    baseRef: String(data.baseRefName ?? ''),
    additions: Number(data.additions ?? 0),
    deletions: Number(data.deletions ?? 0),
    changedFiles: Number(data.changedFiles ?? 0),
    createdAt: String(data.createdAt ?? ''),
    updatedAt: String(data.updatedAt ?? ''),
    checks: parseChecks(data.statusCheckRollup),
    files: parseFiles(data.files),
  };
}

/** Worst first: which of two reports on the same check name is the one to keep. */
const CHECK_SEVERITY: Record<PrCheck['status'], number> = {
  failure: 4,
  pending: 3,
  success: 2,
  neutral: 1,
  skipped: 0,
};

/**
 * `statusCheckRollup` mixes check runs (a `status` and, once done, a `conclusion`) with commit
 * statuses (a `state`), and a check name can appear several times — a re-run, or one workflow
 * triggered more than once. Each name is kept once, at its worst report.
 */
export function parseChecks(raw: unknown): PrCheck[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  const byName = new Map<string, PrCheck>();
  for (const item of raw) {
    if (typeof item !== 'object' || item === null) {
      continue;
    }
    const entry = item as Record<string, unknown>;
    const name = typeof entry.name === 'string' && entry.name !== ''
      ? entry.name
      : typeof entry.context === 'string' ? entry.context : '';
    if (!name) {
      continue;
    }
    const status = checkStatus(entry);
    const seen = byName.get(name);
    if (!seen || CHECK_SEVERITY[status] > CHECK_SEVERITY[seen.status]) {
      byName.set(name, { name, status });
    }
  }
  return [...byName.values()];
}

function checkStatus(entry: Record<string, unknown>): PrCheck['status'] {
  // A check run that has not completed, whatever it calls that (IN_PROGRESS, QUEUED, WAITING), has
  // no conclusion yet; a commit status has only its state.
  const runStatus = typeof entry.status === 'string' ? entry.status.toUpperCase() : '';
  if (runStatus && runStatus !== 'COMPLETED') {
    return 'pending';
  }
  const outcome = typeof entry.conclusion === 'string' && entry.conclusion !== ''
    ? entry.conclusion.toUpperCase()
    : typeof entry.state === 'string' ? entry.state.toUpperCase() : '';
  switch (outcome) {
    case 'SUCCESS':
      return 'success';
    case 'SKIPPED':
      return 'skipped';
    // A run that was cancelled or superseded never decided anything, so it must not outrank the
    // re-run of the same check that did: neutral loses to that run's success.
    case 'NEUTRAL':
    case 'CANCELLED':
    case 'STALE':
      return 'neutral';
    case 'PENDING':
    case 'EXPECTED':
    case '':
      return 'pending';
    default:
      return 'failure';
  }
}

export function parseFiles(raw: unknown): PrFile[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  const files: PrFile[] = [];
  for (const item of raw) {
    const entry = item as Record<string, unknown> | null;
    if (typeof entry?.path !== 'string' || entry.path === '') {
      continue;
    }
    files.push({
      path: entry.path,
      additions: Number(entry.additions ?? 0),
      deletions: Number(entry.deletions ?? 0),
    });
    if (files.length === MAX_SNAPSHOT_FILES) {
      break;
    }
  }
  return files;
}

/**
 * What CI amounts to for a head: one word for the whole set of checks. Nothing passed unless
 * something actually ran — a set with no verdict in it at all, skipped or undecided, is as good as
 * no checks.
 */
export function ciState(checks: PrCheck[]): CiState {
  if (checks.some(check => check.status === 'failure')) {
    return 'failing';
  }
  if (checks.some(check => check.status === 'pending')) {
    return 'running';
  }
  return checks.some(check => check.status === 'success') ? 'passing' : 'none';
}

function isPrState(value: unknown): value is PrState {
  return typeof value === 'string' && (PR_STATES as readonly string[]).includes(value);
}

/** Beyond this a body says nothing more a review needs, and the context file stays readable. */
export const MAX_CONTEXT_BODY = 20_000;

/** Text held to a length, with a marker so a reader knows something was left out. */
export function cutText(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}\n… [cut]`;
}

/** One comment on the pull request itself, rather than on a line of it. */
export interface PrContextComment {
  author: string;
  createdAt: string;
  body: string;
}

/** One submitted review: what it decided, and whatever was said alongside the decision. */
export interface PrContextReview {
  author: string;
  state: string;
  submittedAt: string;
  body: string;
}

/** One inline review comment, on the line of the file it was left on. */
export interface PrContextReviewComment {
  author: string;
  path: string;
  line: number | null;
  side: string;
  createdAt: string;
  body: string;
  /** The comment this one answers, where it answers one. */
  inReplyTo: number | null;
}

/** Everything a pull request carries in words: the description, and the discussion around it. */
export interface PrContext extends PrRef {
  title: string;
  author: string;
  url: string;
  headSha: string;
  baseRef: string;
  body: string;
  /** Oldest first, as the forge returns them. */
  comments: PrContextComment[];
  reviews: PrContextReview[];
  reviewComments: PrContextReviewComment[];
}

/** How a gh call is made, so a caller can hand in its own and nothing reaches the forge. */
export type GhRun = (args: string[]) => Promise<string>;

/** One page of inline review comments; the forge's own maximum. */
const COMMENTS_PER_PAGE = 100;

/** Enough pages for any discussion a review has to read, and a stop for one that never ends. */
const MAX_COMMENT_PAGES = 10;

/**
 * What the pull request carries in words, read with this process's own credentials. The description
 * comes off the snapshot; the discussion — comments on the pull request, submitted reviews, and the
 * inline comments those reviews left — comes from the forge. A forge that cannot be read throws, so
 * the caller decides what a missing discussion means for the review.
 */
export async function fetchPrContext(snapshot: PrSnapshot, run: GhRun = ghAsync): Promise<PrContext> {
  const repo = `${snapshot.owner}/${snapshot.repo}`;
  const discussion = await run([
    'pr', 'view', String(snapshot.number), '--repo', repo, '--json', 'comments,reviews',
  ]);
  const reviewComments: PrContextReviewComment[] = [];
  for (let page = 1; page <= MAX_COMMENT_PAGES; page++) {
    const pageComments = parseReviewComments(await run([
      'api', `repos/${repo}/pulls/${snapshot.number}/comments?per_page=${COMMENTS_PER_PAGE}&page=${page}`,
    ]));
    reviewComments.push(...pageComments);
    if (pageComments.length < COMMENTS_PER_PAGE) {
      break;
    }
  }
  return {
    owner: snapshot.owner,
    repo: snapshot.repo,
    number: snapshot.number,
    title: snapshot.title,
    author: snapshot.author,
    url: snapshot.url,
    headSha: snapshot.headSha,
    baseRef: snapshot.baseRef,
    body: cutText(snapshot.body, MAX_CONTEXT_BODY),
    ...parseDiscussion(discussion),
    reviewComments,
  };
}

/** The comments and reviews of one `gh pr view --json comments,reviews`. */
export function parseDiscussion(json: string): { comments: PrContextComment[]; reviews: PrContextReview[] } {
  const data = JSON.parse(json);
  return {
    comments: objects(data?.comments).map(raw => ({
      author: String(raw.author?.login ?? 'unknown'),
      createdAt: String(raw.createdAt ?? ''),
      body: cutText(String(raw.body ?? ''), MAX_CONTEXT_BODY),
    })),
    reviews: objects(data?.reviews).map(raw => ({
      author: String(raw.author?.login ?? 'unknown'),
      state: String(raw.state ?? 'COMMENTED'),
      submittedAt: String(raw.submittedAt ?? ''),
      body: cutText(String(raw.body ?? ''), MAX_CONTEXT_BODY),
    })),
  };
}

/** One page of `gh api .../pulls/<n>/comments`, the forge's own field names and all. */
export function parseReviewComments(json: string): PrContextReviewComment[] {
  return objects(JSON.parse(json)).map(raw => ({
    author: String(raw.user?.login ?? 'unknown'),
    path: String(raw.path ?? ''),
    line: typeof raw.line === 'number' ? raw.line : null,
    side: String(raw.side ?? 'RIGHT'),
    createdAt: String(raw.created_at ?? ''),
    body: cutText(String(raw.body ?? ''), MAX_CONTEXT_BODY),
    inReplyTo: typeof raw.in_reply_to_id === 'number' ? raw.in_reply_to_id : null,
  }));
}

/** The objects of whatever the forge answered with, so a null or a string in the list is skipped. */
function objects(raw: unknown) {
  return Array.isArray(raw) ? raw.filter(item => typeof item === 'object' && item !== null) : [];
}
