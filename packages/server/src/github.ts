import type { PrReview } from '@diffity/api';
import type { Users } from './users.js';

/** Whose GitHub credentials act for a user. */
export interface GitHubAccess {
  tokenFor(userId: string): Promise<string | null>;
}

/** A token the user pasted on the settings page, for a server without the GitHub App. */
export class StoredTokenAccess implements GitHubAccess {
  constructor(private readonly users: Users, private readonly fallbackToken: string | null) {}

  async tokenFor(userId: string): Promise<string | null> {
    return (await this.users.gitHubToken(userId)) ?? this.fallbackToken;
  }
}

export interface RepoInfo {
  owner: string;
  name: string;
}

export interface PullInfo {
  title: string;
  url: string;
  createdAt: string;
  author: string;
  body: string;
  baseSha: string;
  headSha: string;
  headRef: string;
  baseRef: string;
}

export interface ReviewComment {
  id: number;
  path: string;
  line: number | null;
  startLine: number | null;
  side: string;
  body: string;
  inReplyToId: number | null;
  login: string;
  isBot: boolean;
  createdAt: string;
}

export interface RemoteThreadState {
  filePath: string;
  side: 'old' | 'new';
  endLine: number | null;
  body: string;
  isResolved: boolean;
  /** The forge's id for the thread's first comment. */
  firstCommentId: number | null;
}

export interface ReviewCommentPayload {
  path: string;
  side: string;
  line: number;
  body: string;
  start_line?: number;
  start_side?: string;
}

export interface ReviewRequest {
  owner: string;
  repo: string;
  number: number;
  title: string;
  author: string;
  draft: boolean;
  updatedAt: string;
  url: string;
}

interface RawSearchIssue {
  number: number;
  title: string;
  html_url: string;
  repository_url: string;
  updated_at: string;
  draft?: boolean;
  user?: { login?: string } | null;
}

export class GitHubApiError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

type Fetch = typeof fetch;

const PAGE_SIZE = 100;
const MAX_PAGES = 30;

const REVIEW_REQUESTS_QUERY = 'is:pr is:open archived:false review-requested:@me';

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
          comments(first:1){ nodes{ body fullDatabaseId } }
        }
      }
    }
  }
}`;

interface RawReviewThread {
  isResolved: boolean;
  line: number | null;
  originalLine: number | null;
  diffSide: string;
  path: string;
  comments?: { nodes?: { body: string; fullDatabaseId?: string | null }[] };
}

interface RawComment {
  id: number;
  path: string;
  line: number | null;
  start_line: number | null;
  side: string;
  body: string;
  in_reply_to_id?: number | null;
  user?: { login?: string; type?: string } | null;
  created_at: string;
}

function repoPath(owner: string, repo: string): string {
  return `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
}

function toReviewComment(raw: RawComment): ReviewComment {
  return {
    id: raw.id,
    path: raw.path,
    line: raw.line ?? null,
    startLine: raw.start_line ?? null,
    side: raw.side,
    body: raw.body,
    inReplyToId: raw.in_reply_to_id ?? null,
    login: raw.user?.login ?? '',
    isBot: raw.user?.type === 'Bot',
    createdAt: raw.created_at,
  };
}

export class GitHubApi {
  private readonly logins = new Map<string, Promise<string | null>>();

  constructor(private readonly apiUrl: string, private readonly fetchImpl: Fetch = fetch) {}

  private async request(token: string | null, path: string, init: { method?: string; body?: unknown } = {}): Promise<Response> {
    const headers: Record<string, string> = {
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'diffity-server',
    };
    if (token) {
      headers.Authorization = `Bearer ${token}`;
    }
    if (init.body !== undefined) {
      headers['Content-Type'] = 'application/json';
    }
    return this.fetchImpl(`${this.apiUrl}${path}`, {
      method: init.method ?? 'GET',
      headers,
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      signal: AbortSignal.timeout(60_000),
    });
  }

  private async json<T>(token: string | null, path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
    const res = await this.request(token, path, init);
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      let message = detail;
      try {
        const parsed = JSON.parse(detail) as { message?: string; errors?: unknown[] };
        message = [parsed.message, ...(parsed.errors ?? []).map(e => (typeof e === 'string' ? e : JSON.stringify(e)))]
          .filter(Boolean)
          .join(': ');
      } catch {
        // Not JSON; the text is the message.
      }
      throw new GitHubApiError(`GitHub answered ${res.status} for ${init.method ?? 'GET'} ${path.split('?')[0]}${message ? `: ${message}` : ''}`, res.status);
    }
    return (await res.json()) as T;
  }

  private async paginate<T>(token: string | null, path: string): Promise<T[]> {
    const items: T[] = [];
    for (let page = 1; page <= MAX_PAGES; page++) {
      const separator = path.includes('?') ? '&' : '?';
      const batch = await this.json<T[]>(token, `${path}${separator}per_page=${PAGE_SIZE}&page=${page}`);
      items.push(...batch);
      if (batch.length < PAGE_SIZE) {
        break;
      }
    }
    return items;
  }

  /**
   * Whether this token may read the repository, answered by GitHub itself. Null for both "does not
   * exist" and "not yours": GitHub answers 404 to both so as not to say which.
   */
  async getRepo(token: string | null, owner: string, repo: string): Promise<RepoInfo | null> {
    const res = await this.request(token, repoPath(owner, repo));
    if (res.status === 404 || res.status === 403 || res.status === 401) {
      return null;
    }
    if (!res.ok) {
      throw new GitHubApiError(`GitHub answered ${res.status} for ${owner}/${repo}`, res.status);
    }
    const json = (await res.json()) as { name: string; owner: { login: string } };
    return { owner: json.owner.login, name: json.name };
  }

  async getPull(token: string | null, owner: string, repo: string, prNumber: number): Promise<PullInfo | null> {
    const res = await this.request(token, `${repoPath(owner, repo)}/pulls/${prNumber}`);
    if (res.status === 404) {
      return null;
    }
    if (!res.ok) {
      throw new GitHubApiError(`GitHub answered ${res.status} for ${owner}/${repo}#${prNumber}`, res.status);
    }
    const json = (await res.json()) as {
      title: string;
      html_url: string;
      created_at: string;
      body: string | null;
      user: { login: string } | null;
      base: { sha: string; ref: string };
      head: { sha: string; ref: string };
    };
    return {
      title: json.title,
      url: json.html_url,
      createdAt: json.created_at,
      author: json.user?.login ?? '',
      body: json.body ?? '',
      baseSha: json.base.sha,
      headSha: json.head.sha,
      headRef: json.head.ref,
      baseRef: json.base.ref,
    };
  }

  /** The token's own account; asked once per token. */
  viewerLogin(token: string): Promise<string | null> {
    let login = this.logins.get(token);
    if (!login) {
      if (this.logins.size > 1000) {
        this.logins.clear();
      }
      login = this.json<{ login?: string }>(token, '/user').then(user => user.login ?? null, () => null);
      login.then(value => {
        if (value === null) {
          this.logins.delete(token);
        }
      });
      this.logins.set(token, login);
    }
    return login;
  }

  /** Open pull requests waiting for the token's own review, most recently updated first. */
  async reviewRequests(token: string): Promise<ReviewRequest[]> {
    const query = new URLSearchParams({ q: REVIEW_REQUESTS_QUERY, sort: 'updated', order: 'desc', per_page: '50' });
    let result: { items?: RawSearchIssue[] };
    try {
      result = await this.json(token, `/search/issues?${query.toString()}`);
    } catch (err) {
      // A search GitHub refuses (rate limit, an App without access) leaves the list empty, not the page broken.
      if (err instanceof GitHubApiError && (err.status === 422 || err.status === 403)) {
        console.warn(`Listing review requests failed: ${err.message}`);
        return [];
      }
      throw err;
    }
    return (result.items ?? []).flatMap(item => {
      const repo = /\/repos\/([^/]+)\/([^/]+)$/.exec(item.repository_url);
      if (!repo) {
        return [];
      }
      return [{
        owner: decodeURIComponent(repo[1]),
        repo: decodeURIComponent(repo[2]),
        number: item.number,
        title: item.title,
        author: item.user?.login ?? '',
        draft: !!item.draft,
        updatedAt: item.updated_at,
        url: item.html_url,
      }];
    });
  }

  async pullComments(token: string, owner: string, repo: string, prNumber: number): Promise<ReviewComment[]> {
    return (await this.paginate<RawComment>(token, `${repoPath(owner, repo)}/pulls/${prNumber}/comments`)).map(toReviewComment);
  }

  async reviews(token: string, owner: string, repo: string, prNumber: number): Promise<PrReview[]> {
    const raw = await this.paginate<{ user?: { login?: string; type?: string }; state?: string; body?: string; submitted_at?: string }>(
      token,
      `${repoPath(owner, repo)}/pulls/${prNumber}/reviews`,
    );
    return raw
      .map(review => ({
        author: review.user?.login ?? 'unknown',
        isBot: review.user?.type === 'Bot',
        state: review.state ?? 'COMMENTED',
        body: review.body ?? '',
        submittedAt: review.submitted_at ?? '',
      }))
      // A review with no body and no verdict is the wrapper of a batch of inline comments.
      .filter(review => review.body.trim().length > 0 || review.state !== 'COMMENTED');
  }

  async createReview(
    token: string,
    owner: string,
    repo: string,
    prNumber: number,
    review: { commit_id: string; event: string; body: string; comments: ReviewCommentPayload[] },
  ): Promise<{ id: number; htmlUrl: string | null }> {
    const json = await this.json<{ id: number; html_url?: string }>(token, `${repoPath(owner, repo)}/pulls/${prNumber}/reviews`, {
      method: 'POST',
      body: review,
    });
    return { id: json.id, htmlUrl: json.html_url ?? null };
  }

  async reviewComments(token: string, owner: string, repo: string, prNumber: number, reviewId: number): Promise<ReviewComment[]> {
    return (await this.paginate<RawComment>(token, `${repoPath(owner, repo)}/pulls/${prNumber}/reviews/${reviewId}/comments`))
      .map(toReviewComment);
  }

  /**
   * Whether the author has ticked a thread off, which lives on GraphQL's review threads only. One
   * page: past a hundred threads the rest are left open here, never wrongly closed. Null when the
   * question could not be asked, as opposed to asked with nothing back.
   */
  async threadState(token: string, owner: string, repo: string, prNumber: number): Promise<RemoteThreadState[] | null> {
    try {
      const json = await this.json<{
        data?: { repository?: { pullRequest?: { reviewThreads?: { nodes?: RawReviewThread[] } } } };
      }>(token, '/graphql', { method: 'POST', body: { query: REVIEW_THREADS_QUERY, variables: { owner, repo, number: prNumber } } });
      const nodes = json.data?.repository?.pullRequest?.reviewThreads?.nodes;
      if (!nodes) {
        return null;
      }
      return nodes.flatMap(node => {
        const first = node.comments?.nodes?.[0];
        if (!first?.body || !node.path) {
          return [];
        }
        return [{
          filePath: node.path,
          side: node.diffSide === 'LEFT' ? 'old' as const : 'new' as const,
          endLine: node.line ?? node.originalLine ?? null,
          body: first.body,
          isResolved: !!node.isResolved,
          firstCommentId: first.fullDatabaseId != null ? Number(first.fullDatabaseId) : null,
        }];
      });
    } catch {
      return null;
    }
  }
}
