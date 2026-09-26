import type { GitHubAppConfig } from './config.js';
import type { Db, Queryable } from './db.js';
import { decrypt, encrypt, randomToken, sha256 } from './crypto.js';
import type { GitHubAccess, GitHubApi } from './github.js';

type Fetch = typeof fetch;

interface TokenResponse {
  access_token?: string;
  expires_in?: number;
  refresh_token?: string;
  refresh_token_expires_in?: number;
  error?: string;
  error_description?: string;
}

interface TokenRow {
  github_access_token: string | null;
  github_access_expires_at: number | null;
  github_refresh_token: string | null;
  github_refresh_expires_at: number | null;
}

export class GitHubConnectError extends Error {}

const STATE_TTL_MS = 10 * 60 * 1000;
/** Refreshed this long before GitHub would refuse it, so a request never starts with a dying token. */
const EXPIRY_MARGIN_MS = 60 * 1000;

/**
 * A GitHub App's user-to-server tokens: the user authorizes the App once, and it acts as them,
 * limited to the repositories the App is installed on. Access tokens expire after hours and are
 * refreshed here; the refresh token rotates with every use.
 */
export class GitHubAppAccess implements GitHubAccess {
  constructor(
    private readonly db: Db,
    private readonly secretKey: Buffer,
    private readonly app: GitHubAppConfig,
    private readonly options: {
      githubUrl: string;
      api: GitHubApi;
      callbackUrl: string;
      fallbackToken: string | null;
      fetchImpl?: Fetch;
      now?: () => number;
    },
  ) {}

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }

  get installUrl(): string | null {
    return this.app.slug ? `${this.options.githubUrl}/apps/${encodeURIComponent(this.app.slug)}/installations/new` : null;
  }

  /** Where to send the user; the state is bound to them and good for one callback. */
  async authorizeUrl(userId: string): Promise<string> {
    const state = randomToken();
    await this.db.query('DELETE FROM github_oauth_states WHERE expires_at < $1', [this.now()]);
    await this.db.query('INSERT INTO github_oauth_states (state_hash, user_id, expires_at) VALUES ($1, $2, $3)', [
      sha256(state),
      userId,
      this.now() + STATE_TTL_MS,
    ]);
    const query = new URLSearchParams({ client_id: this.app.clientId, redirect_uri: this.options.callbackUrl, state });
    return `${this.options.githubUrl}/login/oauth/authorize?${query}`;
  }

  /** The callback: trades the code for tokens, for the user who started the flow and nobody else. */
  async complete(userId: string, code: string, state: string): Promise<string> {
    const row = await this.db.one<{ user_id: string; expires_at: number }>(
      'DELETE FROM github_oauth_states WHERE state_hash = $1 RETURNING user_id, expires_at',
      [sha256(state)],
    );
    if (!row || row.user_id !== userId || row.expires_at < this.now()) {
      throw new GitHubConnectError('This GitHub connection request has expired or is not yours. Start again from Settings.');
    }
    const tokens = await this.exchange({ code, redirect_uri: this.options.callbackUrl });
    if (!tokens.access_token) {
      throw new GitHubConnectError(`GitHub refused the connection: ${tokens.error_description ?? tokens.error ?? 'no token'}`);
    }
    const login = await this.options.api.viewerLogin(tokens.access_token);
    await this.store(this.db, userId, tokens, login);
    return login ?? '';
  }

  /** Null when not connected; empty when connected but GitHub did not say as whom. */
  async connectedLogin(userId: string): Promise<string | null> {
    const row = await this.db.one<{ github_access_token: string | null; github_login: string | null }>(
      'SELECT github_access_token, github_login FROM users WHERE id = $1',
      [userId],
    );
    return row?.github_access_token ? row.github_login ?? '' : null;
  }

  async disconnect(userId: string): Promise<void> {
    await this.clear(this.db, userId);
  }

  async tokenFor(userId: string): Promise<string | null> {
    const row = await this.db.one<TokenRow>('SELECT * FROM users WHERE id = $1', [userId]);
    if (!row?.github_access_token) {
      return this.options.fallbackToken;
    }
    if (this.fresh(row)) {
      return decrypt(this.secretKey, row.github_access_token);
    }
    return this.refresh(userId);
  }

  private fresh(row: TokenRow): boolean {
    return row.github_access_expires_at === null || row.github_access_expires_at - EXPIRY_MARGIN_MS > this.now();
  }

  /**
   * Under a row lock: the refresh token is single use, so a second instance refreshing the same
   * user at the same moment would otherwise spend it twice and lose the connection.
   */
  private refresh(userId: string): Promise<string | null> {
    return this.db.transaction(async tx => {
      const row = await tx.one<TokenRow>('SELECT * FROM users WHERE id = $1 FOR UPDATE', [userId]);
      if (!row?.github_access_token) {
        return null;
      }
      if (this.fresh(row)) {
        return decrypt(this.secretKey, row.github_access_token);
      }
      const refreshToken = row.github_refresh_token
        && (row.github_refresh_expires_at === null || row.github_refresh_expires_at > this.now())
        ? decrypt(this.secretKey, row.github_refresh_token)
        : null;
      if (!refreshToken) {
        await this.clear(tx, userId);
        return null;
      }
      const tokens = await this.exchange({ grant_type: 'refresh_token', refresh_token: refreshToken });
      if (!tokens.access_token) {
        await this.clear(tx, userId);
        return null;
      }
      await this.store(tx, userId, tokens);
      return tokens.access_token;
    });
  }

  /** GitHub answers a refused grant with 200 and an `error` field; anything else is an outage. */
  private async exchange(params: Record<string, string>): Promise<TokenResponse> {
    const res = await (this.options.fetchImpl ?? fetch)(`${this.options.githubUrl}/login/oauth/access_token`, {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': 'diffity-server' },
      body: new URLSearchParams({ client_id: this.app.clientId, client_secret: this.app.clientSecret, ...params }).toString(),
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) {
      throw new Error(`GitHub answered ${res.status} to a token request`);
    }
    return (await res.json()) as TokenResponse;
  }

  private async store(tx: Queryable, userId: string, tokens: TokenResponse, login?: string | null): Promise<void> {
    const now = this.now();
    await tx.query(
      `UPDATE users SET github_access_token = $1, github_access_expires_at = $2, github_refresh_token = $3,
         github_refresh_expires_at = $4, github_login = COALESCE($5, github_login) WHERE id = $6`,
      [
        encrypt(this.secretKey, tokens.access_token!),
        tokens.expires_in ? now + tokens.expires_in * 1000 : null,
        tokens.refresh_token ? encrypt(this.secretKey, tokens.refresh_token) : null,
        tokens.refresh_token_expires_in ? now + tokens.refresh_token_expires_in * 1000 : null,
        login ?? null,
        userId,
      ],
    );
  }

  private async clear(tx: Queryable, userId: string): Promise<void> {
    await tx.query(
      `UPDATE users SET github_access_token = NULL, github_access_expires_at = NULL, github_refresh_token = NULL,
         github_refresh_expires_at = NULL, github_login = NULL WHERE id = $1`,
      [userId],
    );
  }
}
