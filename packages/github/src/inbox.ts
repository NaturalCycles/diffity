import { ghAsync } from './exec.js';

/** Which pull request, by the coordinates every gh call takes. */
export interface PrRef {
  owner: string;
  repo: string;
  number: number;
}

export const PR_STATES = ['OPEN', 'CLOSED', 'MERGED'] as const;
export type PrState = (typeof PR_STATES)[number];

/** What one `gh pr view` says about a pull request, as far as the inbox cares. */
export interface PrSnapshot extends PrRef {
  title: string;
  url: string;
  author: string;
  isBot: boolean;
  isDraft: boolean;
  state: PrState;
  headSha: string;
  baseRef: string;
  additions: number;
  deletions: number;
  changedFiles: number;
  updatedAt: string;
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
      '--json', 'number,title,url,author,isDraft,state,headRefOid,baseRefName,additions,deletions,changedFiles,updatedAt',
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
    author: String(data.author?.login ?? ''),
    isBot: data.author?.is_bot === true,
    isDraft: data.isDraft === true,
    state: data.state,
    headSha: data.headRefOid,
    baseRef: String(data.baseRefName ?? ''),
    additions: Number(data.additions ?? 0),
    deletions: Number(data.deletions ?? 0),
    changedFiles: Number(data.changedFiles ?? 0),
    updatedAt: String(data.updatedAt ?? ''),
  };
}

function isPrState(value: unknown): value is PrState {
  return typeof value === 'string' && (PR_STATES as readonly string[]).includes(value);
}
