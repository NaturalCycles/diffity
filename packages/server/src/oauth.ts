import type { Response } from 'express';
import type { AuthorizationParams, OAuthServerProvider } from '@modelcontextprotocol/sdk/server/auth/provider.js';
import type { OAuthRegisteredClientsStore } from '@modelcontextprotocol/sdk/server/auth/clients.js';
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import type {
  OAuthClientInformationFull,
  OAuthTokenRevocationRequest,
  OAuthTokens,
} from '@modelcontextprotocol/sdk/shared/auth.js';
import { InvalidGrantError, InvalidTargetError, InvalidTokenError } from '@modelcontextprotocol/sdk/server/auth/errors.js';
import type { Db } from './db.js';
import { randomToken, sha256 } from './crypto.js';

export type AuthorizeHandler = (
  client: OAuthClientInformationFull,
  params: AuthorizationParams,
  res: Response,
) => Promise<void>;

export interface OAuthOptions {
  /** The MCP endpoint. A token is for this resource and nothing else. */
  resourceUrl: URL;
  accessTtlSeconds?: number;
  refreshTtlSeconds?: number;
  codeTtlSeconds?: number;
  now?: () => number;
}

interface ClientRow {
  client_id: string;
  client_secret_hash: string | null;
  metadata: string;
}

interface CodeRow {
  client_id: string;
  user_id: string;
  code_challenge: string;
  redirect_uri: string;
  scopes: string;
  resource: string | null;
  expires_at: number;
}

interface TokenRow {
  kind: 'access' | 'refresh';
  client_id: string;
  user_id: string;
  scopes: string;
  resource: string | null;
  expires_at: number;
}

function sameResource(a: string, b: string): boolean {
  const strip = (value: string) => new URL(value).href.replace(/#.*$/, '').replace(/\/$/, '');
  try {
    return strip(a) === strip(b);
  } catch {
    return false;
  }
}

/**
 * The SDK compares a presented client secret with the stored one as plain strings. The table holds
 * only a hash, so the secret is hashed on the way in (see `hashPresentedClientSecret`) and the
 * store hands out the hash as the client's secret: a hash compares equal only to a hash of the
 * same secret, and a presented hash is hashed again and matches nothing.
 */
export class DbClientsStore implements OAuthRegisteredClientsStore {
  constructor(private readonly db: Db) {}

  async getClient(clientId: string): Promise<OAuthClientInformationFull | undefined> {
    const row = await this.db.one<ClientRow>('SELECT * FROM oauth_clients WHERE client_id = $1', [clientId]);
    if (!row) {
      return undefined;
    }
    const metadata = JSON.parse(row.metadata) as OAuthClientInformationFull;
    return row.client_secret_hash ? { ...metadata, client_secret: row.client_secret_hash } : metadata;
  }

  async registerClient(client: Omit<OAuthClientInformationFull, 'client_id' | 'client_id_issued_at'>): Promise<OAuthClientInformationFull> {
    const full = client as OAuthClientInformationFull;
    const { client_secret: secret, ...metadata } = full;
    await this.db.query(
      'INSERT INTO oauth_clients (client_id, client_secret_hash, metadata, created_at) VALUES ($1, $2, $3, $4)',
      [full.client_id, secret ? sha256(secret) : null, JSON.stringify(metadata), new Date().toISOString()],
    );
    return full;
  }

  async clientName(clientId: string): Promise<string | null> {
    const row = await this.db.one<ClientRow>('SELECT metadata FROM oauth_clients WHERE client_id = $1', [clientId]);
    if (!row) {
      return null;
    }
    const name = (JSON.parse(row.metadata) as { client_name?: unknown }).client_name;
    return typeof name === 'string' && name.trim() ? name.trim() : null;
  }
}

/** Installed on `/token` and `/revoke` ahead of the SDK's handlers; see `DbClientsStore`. */
export function hashPresentedClientSecret(body: unknown): void {
  if (body && typeof body === 'object' && typeof (body as { client_secret?: unknown }).client_secret === 'string') {
    const record = body as { client_secret: string };
    record.client_secret = sha256(record.client_secret);
  }
}

/**
 * An OAuth 2.1 authorization server for the MCP endpoint, backed by the database. Codes and tokens
 * are opaque random strings; only their sha256 is stored, so a copy of the database grants nothing.
 * Signing in and consenting are the web layer's, handed in as `onAuthorize`.
 */
export class OAuthProvider implements OAuthServerProvider {
  readonly clientsStore: DbClientsStore;
  private readonly accessTtl: number;
  private readonly refreshTtl: number;
  private readonly codeTtl: number;
  private readonly now: () => number;
  onAuthorize: AuthorizeHandler = async () => {
    throw new Error('No authorization handler is installed');
  };

  constructor(private readonly db: Db, private readonly options: OAuthOptions) {
    this.clientsStore = new DbClientsStore(db);
    this.accessTtl = options.accessTtlSeconds ?? 60 * 60;
    this.refreshTtl = options.refreshTtlSeconds ?? 30 * 24 * 60 * 60;
    this.codeTtl = options.codeTtlSeconds ?? 10 * 60;
    this.now = options.now ?? (() => Math.floor(Date.now() / 1000));
  }

  async authorize(client: OAuthClientInformationFull, params: AuthorizationParams, res: Response): Promise<void> {
    if (params.resource && !sameResource(params.resource.href, this.options.resourceUrl.href)) {
      throw new InvalidTargetError(`This server only issues tokens for ${this.options.resourceUrl.href}`);
    }
    await this.onAuthorize(client, params, res);
  }

  /** Called once the signed-in user has agreed; the plaintext code goes to the client's redirect. */
  async issueCode(clientId: string, userId: string, params: AuthorizationParams): Promise<string> {
    const code = randomToken();
    await this.db.query(
      `INSERT INTO oauth_codes (code_hash, client_id, user_id, code_challenge, redirect_uri, scopes, resource, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        sha256(code),
        clientId,
        userId,
        params.codeChallenge,
        params.redirectUri,
        (params.scopes ?? []).join(' '),
        params.resource?.href ?? null,
        this.now() + this.codeTtl,
      ],
    );
    return code;
  }

  private async liveCode(client: OAuthClientInformationFull, code: string): Promise<CodeRow> {
    const row = await this.db.one<CodeRow>('SELECT * FROM oauth_codes WHERE code_hash = $1', [sha256(code)]);
    if (!row || row.client_id !== client.client_id || row.expires_at < this.now()) {
      throw new InvalidGrantError('Invalid or expired authorization code');
    }
    return row;
  }

  async challengeForAuthorizationCode(client: OAuthClientInformationFull, authorizationCode: string): Promise<string> {
    return (await this.liveCode(client, authorizationCode)).code_challenge;
  }

  async exchangeAuthorizationCode(
    client: OAuthClientInformationFull,
    authorizationCode: string,
    _codeVerifier?: string,
    redirectUri?: string,
    resource?: URL,
  ): Promise<OAuthTokens> {
    const row = await this.liveCode(client, authorizationCode);
    // Single use: whoever consumes the row first gets the tokens, and a replay finds nothing.
    const consumed = await this.db.one('DELETE FROM oauth_codes WHERE code_hash = $1 RETURNING code_hash', [sha256(authorizationCode)]);
    if (!consumed) {
      throw new InvalidGrantError('Invalid or expired authorization code');
    }
    if (redirectUri !== undefined && redirectUri !== row.redirect_uri) {
      throw new InvalidGrantError('redirect_uri does not match the authorization request');
    }
    if (resource && row.resource && !sameResource(resource.href, row.resource)) {
      throw new InvalidGrantError('resource does not match the authorization request');
    }
    return this.issueTokens(row.client_id, row.user_id, row.scopes, row.resource);
  }

  async exchangeRefreshToken(
    client: OAuthClientInformationFull,
    refreshToken: string,
    scopes?: string[],
    resource?: URL,
  ): Promise<OAuthTokens> {
    const hash = sha256(refreshToken);
    const row = await this.db.one<TokenRow>("SELECT * FROM oauth_tokens WHERE token_hash = $1 AND kind = 'refresh'", [hash]);
    if (!row || row.client_id !== client.client_id || row.expires_at < this.now()) {
      throw new InvalidGrantError('Invalid or expired refresh token');
    }
    const granted = row.scopes ? row.scopes.split(' ') : [];
    if (scopes && scopes.some(scope => !granted.includes(scope))) {
      throw new InvalidGrantError('A refresh cannot widen the scopes that were granted');
    }
    if (resource && row.resource && !sameResource(resource.href, row.resource)) {
      throw new InvalidGrantError('resource does not match the original grant');
    }
    // Rotated: a public client's refresh token is a bearer secret, and one that is replayed after
    // being used is one that leaked.
    if (!(await this.db.one('DELETE FROM oauth_tokens WHERE token_hash = $1 RETURNING token_hash', [hash]))) {
      throw new InvalidGrantError('Invalid or expired refresh token');
    }
    return this.issueTokens(row.client_id, row.user_id, scopes ? scopes.join(' ') : row.scopes, row.resource);
  }

  private async issueTokens(clientId: string, userId: string, scopes: string, resource: string | null): Promise<OAuthTokens> {
    const accessToken = randomToken();
    const refreshToken = randomToken();
    const now = this.now();
    const createdAt = new Date(now * 1000).toISOString();
    await this.db.query(
      `INSERT INTO oauth_tokens (token_hash, kind, client_id, user_id, scopes, resource, expires_at, created_at)
       VALUES ($1, 'access', $3, $4, $5, $6, $7, $9), ($2, 'refresh', $3, $4, $5, $6, $8, $9)`,
      [sha256(accessToken), sha256(refreshToken), clientId, userId, scopes, resource, now + this.accessTtl, now + this.refreshTtl, createdAt],
    );
    return {
      access_token: accessToken,
      token_type: 'bearer',
      expires_in: this.accessTtl,
      refresh_token: refreshToken,
      ...(scopes ? { scope: scopes } : {}),
    };
  }

  async verifyAccessToken(token: string): Promise<AuthInfo> {
    const row = await this.db.one<TokenRow>("SELECT * FROM oauth_tokens WHERE token_hash = $1 AND kind = 'access'", [sha256(token)]);
    if (!row || row.expires_at < this.now()) {
      throw new InvalidTokenError('Invalid or expired access token');
    }
    return {
      token,
      clientId: row.client_id,
      scopes: row.scopes ? row.scopes.split(' ') : [],
      expiresAt: row.expires_at,
      ...(row.resource ? { resource: new URL(row.resource) } : {}),
      extra: { userId: row.user_id },
    };
  }

  async revokeToken(client: OAuthClientInformationFull, request: OAuthTokenRevocationRequest): Promise<void> {
    await this.db.query('DELETE FROM oauth_tokens WHERE token_hash = $1 AND client_id = $2', [sha256(request.token), client.client_id]);
  }

  /** Expired rows are dead weight; nothing reads them. */
  async purgeExpired(): Promise<void> {
    const now = this.now();
    await this.db.query('DELETE FROM oauth_codes WHERE expires_at < $1', [now]);
    await this.db.query('DELETE FROM oauth_tokens WHERE expires_at < $1', [now]);
  }
}
