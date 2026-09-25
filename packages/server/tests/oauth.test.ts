import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { Store } from '../src/db.js';
import { OAuthProvider, hashPresentedClientSecret } from '../src/oauth.js';
import { sha256 } from '../src/crypto.js';
import { Users } from '../src/users.js';
import {
  connectAgent,
  login,
  pkcePair,
  removeDir,
  startFakeGitHub,
  startTestServer,
  tempDir,
  type FakeGitHub,
  type TestServer,
} from './helpers.js';
import { randomBytes } from 'node:crypto';

let github: FakeGitHub;
let dataDir: string;
let server: TestServer;
let aliceCookie: string;
let bobCookie: string;

const redirectUri = 'http://127.0.0.1:9/callback';

beforeAll(async () => {
  github = await startFakeGitHub([]);
  dataDir = tempDir('oauth');
  server = await startTestServer(dataDir, github.url);
  aliceCookie = await login(server.base, 'alice@example.com');
  bobCookie = await login(server.base, 'bob@example.com');
});

afterAll(async () => {
  await server.close();
  await github.close();
  removeDir(dataDir);
});

async function register(body: Record<string, unknown> = {}): Promise<{ client_id: string; client_secret?: string }> {
  const res = await fetch(`${server.base}/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ client_name: 'Claude Code', redirect_uris: [redirectUri], token_endpoint_auth_method: 'none', ...body }),
  });
  expect(res.status).toBe(201);
  return (await res.json()) as { client_id: string; client_secret?: string };
}

function authorizePath(clientId: string, challenge: string, extra: Record<string, string> = {}): string {
  return `/authorize?${new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    code_challenge: challenge,
    code_challenge_method: 'S256',
    state: 'st4te',
    ...extra,
  })}`;
}

async function consent(cookie: string, path: string, decision: 'allow' | 'deny'): Promise<URL> {
  const page = await fetch(`${server.base}${path}`, { headers: { cookie }, redirect: 'manual' });
  expect(page.status).toBe(200);
  const request = /name="request" value="([^"]+)"/.exec(await page.text())![1];
  const res = await fetch(`${server.base}/oauth/consent`, {
    method: 'POST',
    redirect: 'manual',
    headers: { cookie, 'Content-Type': 'application/x-www-form-urlencoded', 'Sec-Fetch-Site': 'same-origin' },
    body: new URLSearchParams({ request, decision }).toString(),
  });
  expect(res.status).toBe(302);
  return new URL(res.headers.get('location')!);
}

async function token(body: Record<string, string>): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await fetch(`${server.base}/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(body).toString(),
  });
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}

describe('metadata', () => {
  it('advertises the authorization server and the protected resource', async () => {
    const as = await (await fetch(`${server.base}/.well-known/oauth-authorization-server`)).json();
    expect(as).toMatchObject({
      issuer: `${server.base}/`,
      authorization_endpoint: `${server.base}/authorize`,
      token_endpoint: `${server.base}/token`,
      registration_endpoint: `${server.base}/register`,
      revocation_endpoint: `${server.base}/revoke`,
      code_challenge_methods_supported: ['S256'],
    });
    for (const path of ['/.well-known/oauth-protected-resource/mcp', '/.well-known/oauth-protected-resource']) {
      const prm = await (await fetch(`${server.base}${path}`)).json();
      expect(prm).toMatchObject({ resource: `${server.base}/mcp`, authorization_servers: [`${server.base}/`] });
    }
  });
});

describe('authorization code with PKCE', () => {
  it('sends a visitor who is not signed in to the login page, and back', async () => {
    const client = await register();
    const { challenge } = pkcePair();
    const res = await fetch(`${server.base}${authorizePath(client.client_id, challenge)}`, { redirect: 'manual' });
    expect(res.status).toBe(302);
    const location = new URL(res.headers.get('location')!, server.base);
    expect(location.pathname).toBe('/login');
    const next = location.searchParams.get('next')!;
    expect(next).toMatch(/^\/authorize\?/);
    expect(new URLSearchParams(next.split('?')[1]).get('code_challenge')).toBe(challenge);
  });

  it('asks the signed-in user, names the client, and hands out a code only when allowed', async () => {
    const client = await register();
    const { verifier, challenge } = pkcePair();
    const page = await fetch(`${server.base}${authorizePath(client.client_id, challenge)}`, { headers: { cookie: aliceCookie } });
    const html = await page.text();
    expect(html).toContain('Connect Claude Code?');
    expect(html).toContain('alice@example.com');
    expect(page.headers.get('content-security-policy')).toContain("form-action 'self' http://127.0.0.1:9");

    const denied = await consent(aliceCookie, authorizePath(client.client_id, challenge), 'deny');
    expect(denied.searchParams.get('error')).toBe('access_denied');
    expect(denied.searchParams.get('state')).toBe('st4te');
    expect(denied.searchParams.get('code')).toBeNull();

    const allowed = await consent(aliceCookie, authorizePath(client.client_id, challenge), 'allow');
    expect(allowed.origin + allowed.pathname).toBe(redirectUri);
    expect(allowed.searchParams.get('state')).toBe('st4te');
    const code = allowed.searchParams.get('code')!;

    const wrong = await token({ grant_type: 'authorization_code', code, code_verifier: pkcePair().verifier, client_id: client.client_id });
    expect(wrong.status).toBe(400);
    expect(wrong.json.error).toBe('invalid_grant');

    const ok = await token({ grant_type: 'authorization_code', code, code_verifier: verifier, client_id: client.client_id, redirect_uri: redirectUri });
    expect(ok.status).toBe(200);
    expect(ok.json).toMatchObject({ token_type: 'bearer', expires_in: 3600 });
    expect(typeof ok.json.access_token).toBe('string');

    const replay = await token({ grant_type: 'authorization_code', code, code_verifier: verifier, client_id: client.client_id });
    expect(replay.json.error).toBe('invalid_grant');

    const auth = await server.oauth.verifyAccessToken(ok.json.access_token as string);
    const alice = server.users.findOrCreate('alice@example.com');
    expect(auth.extra?.userId).toBe(alice.id);
    expect(auth.clientId).toBe(client.client_id);
  });

  it('refuses a code for another client, or with another redirect_uri', async () => {
    const client = await register();
    const other = await register();
    const { verifier, challenge } = pkcePair();
    const code = (await consent(aliceCookie, authorizePath(client.client_id, challenge), 'allow')).searchParams.get('code')!;
    expect((await token({ grant_type: 'authorization_code', code, code_verifier: verifier, client_id: other.client_id })).json.error)
      .toBe('invalid_grant');
    const code2 = (await consent(aliceCookie, authorizePath(client.client_id, challenge), 'allow')).searchParams.get('code')!;
    expect((await token({
      grant_type: 'authorization_code', code: code2, code_verifier: verifier, client_id: client.client_id, redirect_uri: 'http://127.0.0.1:9/other',
    })).json.error).toBe('invalid_grant');
  });

  it('issues tokens only for the MCP endpoint', async () => {
    const client = await register();
    const { challenge } = pkcePair();
    const res = await fetch(`${server.base}${authorizePath(client.client_id, challenge, { resource: 'https://elsewhere.example/mcp' })}`, {
      headers: { cookie: aliceCookie },
      redirect: 'manual',
    });
    expect(res.status).toBe(302);
    expect(new URL(res.headers.get('location')!).searchParams.get('error')).toBe('invalid_target');

    const same = await fetch(`${server.base}${authorizePath(client.client_id, challenge, { resource: `${server.base}/mcp` })}`, {
      headers: { cookie: aliceCookie },
    });
    expect(same.status).toBe(200);
  });

  it('refuses a consent from another site, from another user, or given twice', async () => {
    const client = await register();
    const { challenge } = pkcePair();
    const page = await fetch(`${server.base}${authorizePath(client.client_id, challenge)}`, { headers: { cookie: aliceCookie } });
    const request = /name="request" value="([^"]+)"/.exec(await page.text())![1];
    const post = (cookie: string, site: string) => fetch(`${server.base}/oauth/consent`, {
      method: 'POST',
      redirect: 'manual',
      headers: { cookie, 'Content-Type': 'application/x-www-form-urlencoded', 'Sec-Fetch-Site': site },
      body: new URLSearchParams({ request, decision: 'allow' }).toString(),
    });
    expect((await post(aliceCookie, 'cross-site')).status).toBe(403);
    expect((await post(bobCookie, 'same-origin')).status).toBe(400);
    expect((await post(aliceCookie, 'same-origin')).status).toBe(302);
    expect((await post(aliceCookie, 'same-origin')).status).toBe(400);
  });
});

describe('refresh and revocation', () => {
  it('rotates the refresh token on use and refuses the old one', async () => {
    const agent = await connectAgent(server.base, aliceCookie);
    const first = await token({ grant_type: 'refresh_token', refresh_token: agent.refreshToken, client_id: agent.clientId });
    expect(first.status).toBe(200);
    expect(first.json.refresh_token).not.toBe(agent.refreshToken);
    const replay = await token({ grant_type: 'refresh_token', refresh_token: agent.refreshToken, client_id: agent.clientId });
    expect(replay.json.error).toBe('invalid_grant');
    const second = await token({ grant_type: 'refresh_token', refresh_token: first.json.refresh_token as string, client_id: agent.clientId });
    expect(second.status).toBe(200);
    await expect(server.oauth.verifyAccessToken(second.json.access_token as string)).resolves.toBeTruthy();
  });

  it('revokes an access token', async () => {
    const agent = await connectAgent(server.base, aliceCookie);
    await expect(server.oauth.verifyAccessToken(agent.accessToken)).resolves.toBeTruthy();
    const res = await fetch(`${server.base}/revoke`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token: agent.accessToken, client_id: agent.clientId }).toString(),
    });
    expect(res.status).toBe(200);
    await expect(server.oauth.verifyAccessToken(agent.accessToken)).rejects.toThrow('Invalid or expired access token');
  });
});

describe('confidential clients', () => {
  it('stores only the secret’s hash, and accepts the secret but not the hash', async () => {
    const client = await register({ token_endpoint_auth_method: 'client_secret_post' });
    expect(client.client_secret).toBeTruthy();
    const row = server.store.get<{ client_secret_hash: string }>('SELECT client_secret_hash FROM oauth_clients WHERE client_id = ?', client.client_id)!;
    expect(row.client_secret_hash).toBe(sha256(client.client_secret!));

    const { verifier, challenge } = pkcePair();
    const code = (await consent(aliceCookie, authorizePath(client.client_id, challenge), 'allow')).searchParams.get('code')!;
    const withHash = await token({
      grant_type: 'authorization_code', code, code_verifier: verifier, client_id: client.client_id, client_secret: row.client_secret_hash,
    });
    expect(withHash.json.error).toBe('invalid_client');
    const withSecret = await token({
      grant_type: 'authorization_code', code, code_verifier: verifier, client_id: client.client_id, client_secret: client.client_secret!,
    });
    expect(withSecret.status).toBe(200);
  });

  it('leaves a body without a secret alone', () => {
    const body: Record<string, unknown> = { client_id: 'x' };
    hashPresentedClientSecret(body);
    hashPresentedClientSecret(undefined);
    expect(body).toEqual({ client_id: 'x' });
  });
});

describe('storage', () => {
  it('never holds a code or token in plaintext', async () => {
    const agent = await connectAgent(server.base, aliceCookie);
    const dump = JSON.stringify([
      server.store.all('SELECT * FROM oauth_codes'),
      server.store.all('SELECT * FROM oauth_tokens'),
    ]);
    expect(dump).not.toContain(agent.accessToken);
    expect(dump).not.toContain(agent.refreshToken);
    expect(dump).toContain(sha256(agent.accessToken));
  });
});

describe('expiry', () => {
  it('refuses expired codes, access tokens and refresh tokens, and purges them', async () => {
    const dir = tempDir('oauth-expiry');
    const store = new Store(join(dir, 'diffity.db'));
    let now = 1_000_000;
    const provider = new OAuthProvider(store, { resourceUrl: new URL('http://localhost/mcp'), now: () => now });
    const user = new Users(store, randomBytes(32)).findOrCreate('a@example.com');
    const client = provider.clientsStore.registerClient({
      client_id: 'c1', redirect_uris: [redirectUri], token_endpoint_auth_method: 'none',
    } as never);
    const params = { codeChallenge: 'x', redirectUri, scopes: [] };

    const code = provider.issueCode(client.client_id, user.id, params);
    now += 601;
    await expect(provider.challengeForAuthorizationCode(client, code)).rejects.toThrow('expired');

    const fresh = provider.issueCode(client.client_id, user.id, params);
    const tokens = await provider.exchangeAuthorizationCode(client, fresh);
    now += 3601;
    await expect(provider.verifyAccessToken(tokens.access_token)).rejects.toThrow('expired');
    await expect(provider.exchangeRefreshToken(client, tokens.refresh_token!, ['wider'])).rejects.toThrow('cannot widen');
    now += 30 * 24 * 3600;
    await expect(provider.exchangeRefreshToken(client, tokens.refresh_token!)).rejects.toThrow('expired');

    provider.purgeExpired();
    expect(store.all('SELECT * FROM oauth_tokens')).toEqual([]);
    expect(store.all('SELECT * FROM oauth_codes')).toEqual([]);
    expect(provider.clientsStore.clientName('c1')).toBeNull();
    expect(provider.clientsStore.clientName('missing')).toBeNull();
    store.close();
    removeDir(dir);
  });
});
