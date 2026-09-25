import type { Users } from './users.js';

/**
 * Whose GitHub credentials act for a user. Phase 1 reads a token the user pasted; the GitHub App
 * replaces this with an installation token without anything above it changing.
 */
export interface GitHubAccess {
  tokenFor(userId: string): Promise<string | null>;
}

export class StoredTokenAccess implements GitHubAccess {
  constructor(private readonly users: Users, private readonly fallbackToken: string | null) {}

  async tokenFor(userId: string): Promise<string | null> {
    return this.users.gitHubToken(userId) ?? this.fallbackToken;
  }
}

export interface RepoInfo {
  owner: string;
  name: string;
  private: boolean;
}

export interface PullInfo {
  number: number;
  title: string;
  url: string;
  createdAt: string;
  author: string;
  body: string;
  baseSha: string;
  headSha: string;
  headRef: string;
  baseRef: string;
  state: string;
}

export class GitHubApiError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

type Fetch = typeof fetch;

export class GitHubApi {
  constructor(private readonly apiUrl: string, private readonly fetchImpl: Fetch = fetch) {}

  private async request(token: string | null, path: string): Promise<Response> {
    const headers: Record<string, string> = {
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'diffity-server',
    };
    if (token) {
      headers.Authorization = `Bearer ${token}`;
    }
    return this.fetchImpl(`${this.apiUrl}${path}`, { headers, signal: AbortSignal.timeout(20_000) });
  }

  /**
   * Whether this token may read the repository, answered by GitHub itself. Null for both "does not
   * exist" and "not yours": GitHub answers 404 to both so as not to say which.
   */
  async getRepo(token: string | null, owner: string, repo: string): Promise<RepoInfo | null> {
    const res = await this.request(token, `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`);
    if (res.status === 404 || res.status === 403 || res.status === 401) {
      return null;
    }
    if (!res.ok) {
      throw new GitHubApiError(`GitHub answered ${res.status} for ${owner}/${repo}`, res.status);
    }
    const json = (await res.json()) as { name: string; private: boolean; owner: { login: string } };
    return { owner: json.owner.login, name: json.name, private: json.private };
  }

  async getPull(token: string | null, owner: string, repo: string, prNumber: number): Promise<PullInfo | null> {
    const res = await this.request(
      token,
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls/${prNumber}`,
    );
    if (res.status === 404) {
      return null;
    }
    if (!res.ok) {
      throw new GitHubApiError(`GitHub answered ${res.status} for ${owner}/${repo}#${prNumber}`, res.status);
    }
    const json = (await res.json()) as {
      number: number;
      title: string;
      html_url: string;
      created_at: string;
      body: string | null;
      state: string;
      user: { login: string } | null;
      base: { sha: string; ref: string };
      head: { sha: string; ref: string };
    };
    return {
      number: json.number,
      title: json.title,
      url: json.html_url,
      createdAt: json.created_at,
      author: json.user?.login ?? '',
      body: json.body ?? '',
      baseSha: json.base.sha,
      headSha: json.head.sha,
      headRef: json.head.ref,
      baseRef: json.base.ref,
      state: json.state,
    };
  }
}
