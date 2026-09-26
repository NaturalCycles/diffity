import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT, type CryptoKey } from 'jose';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { IAP_HEADER } from '../src/login.js';
import {
  connectAgent,
  fakeUiDir,
  pkcePair,
  removeDir,
  startFakeGitHub,
  startTestServer,
  tempDir,
  type FakeGitHub,
  type TestServer,
} from './helpers.js';

const AUDIENCE = '/projects/123456/global/backendServices/789';

let github: FakeGitHub;
let dataDir: string;
let server: TestServer;
let privateKey: CryptoKey;
let strangerKey: CryptoKey;
let authorizePath: string;

async function assertion(
  claims: { email?: string; aud?: string; iss?: string; exp?: string } = {},
  key: CryptoKey = privateKey,
): Promise<string> {
  return new SignJWT({ email: claims.email ?? 'alice@example.com' })
    .setProtectedHeader({ alg: 'ES256', kid: 'iap-test' })
    .setIssuer(claims.iss ?? 'https://cloud.google.com/iap')
    .setAudience(claims.aud ?? AUDIENCE)
    .setIssuedAt()
    .setExpirationTime(claims.exp ?? '10m')
    .sign(key);
}

async function get(path: string, headers: Record<string, string> = {}): Promise<Response> {
  return fetch(`${server.base}${path}`, { headers, redirect: 'manual' });
}

beforeAll(async () => {
  const pair = await generateKeyPair('ES256');
  privateKey = pair.privateKey;
  strangerKey = (await generateKeyPair('ES256')).privateKey;
  const jwk = { ...(await exportJWK(pair.publicKey)), kid: 'iap-test', alg: 'ES256' };
  github = await startFakeGitHub([]);
  dataDir = tempDir('iap');
  server = await startTestServer(
    dataDir,
    github.url,
    { iapKeys: createLocalJWKSet({ keys: [jwk] }), uiDir: fakeUiDir(dataDir) },
    { devLogin: false, iapAudience: AUDIENCE },
  );
  const registered = await fetch(`${server.base}/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ client_name: 'Agent', redirect_uris: ['http://127.0.0.1:9/cb'], token_endpoint_auth_method: 'none' }),
  });
  const client = (await registered.json()) as { client_id: string };
  authorizePath = `/authorize?${new URLSearchParams({
    client_id: client.client_id,
    redirect_uri: 'http://127.0.0.1:9/cb',
    response_type: 'code',
    code_challenge: pkcePair().challenge,
    code_challenge_method: 'S256',
  })}`;
});

afterAll(async () => {
  await server.close();
  await github.close();
  removeDir(dataDir);
});

describe('behind IAP', () => {
  it('knows the user from the signed header on every request, with no cookie', async () => {
    const res = await get('/', { [IAP_HEADER]: await assertion() });
    expect(res.status).toBe(200);
    expect(res.headers.get('set-cookie')).toBeNull();
    expect(await res.text()).toContain('alice@example.com');
  });

  it.each([
    ['no header', null],
    ['another key', () => assertion({}, strangerKey)],
    ['another audience', () => assertion({ aud: '/projects/1/global/backendServices/2' })],
    ['another issuer', () => assertion({ iss: 'https://evil.example' })],
    ['an expired assertion', () => assertion({ exp: '-1m' })],
    ['an address outside the domain', () => assertion({ email: 'eve@evil.io' })],
  ])('refuses %s with 401 and no login form', async (_label, make) => {
    const headers: Record<string, string> = make ? { [IAP_HEADER]: await make() } : {};
    for (const path of ['/', '/settings', '/login', '/s/anything/', '/github/connect', authorizePath]) {
      const res = await get(path, headers);
      expect(res.status, path).toBe(401);
      expect(await res.text()).not.toContain('<form');
    }
    expect((await get('/s/anything/api/info', headers)).status).toBe(401);
  });

  it('turns the login page into a pass-through, and sign-out into IAP’s', async () => {
    const header = { [IAP_HEADER]: await assertion() };
    const login = await get('/login?next=/settings', header);
    expect(login.status).toBe(302);
    expect(login.headers.get('location')).toBe('/settings');
    const form = await fetch(`${server.base}/login`, {
      method: 'POST', headers: { ...header, 'Sec-Fetch-Site': 'same-origin', 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'email=alice@example.com', redirect: 'manual',
    });
    expect(form.status).toBe(404);
    const out = await fetch(`${server.base}/logout`, { method: 'POST', headers: { ...header, 'Sec-Fetch-Site': 'same-origin' }, redirect: 'manual' });
    expect(out.headers.get('location')).toBe('/_gcp_iap/clear_login_cookie');
  });

  it('connects an agent through /authorize with the header, and serves its session page to the same person', async () => {
    const header = { [IAP_HEADER]: await assertion() };
    const agent = await connectAgent(server.base, header);
    const transport = new StreamableHTTPClientTransport(new URL(`${server.base}/mcp`), {
      requestInit: { headers: { Authorization: `Bearer ${agent.accessToken}` } },
    });
    const client = new Client({ name: 'test', version: '1.0.0' });
    await client.connect(transport);
    try {
      expect((await client.callTool({ name: 'list_sessions', arguments: {} })).isError).toBeFalsy();
    } finally {
      await client.close();
    }

    const aliceId = (await server.users.findOrCreate('alice@example.com')).id;
    const { session } = await server.service.reviews.findOrCreateSession({
      userId: aliceId, owner: 'acme', repo: 'widgets', kind: 'shas', prNumber: null, prMeta: null,
      baseSha: 'a'.repeat(40), headSha: 'b'.repeat(40),
    });
    expect((await get(`/s/${session.id}/`, header)).status).toBe(200);
    expect((await get(`/s/${session.id}/api/info`, header)).status).toBe(200);
    expect((await get(`/s/${session.id}/`, { [IAP_HEADER]: await assertion({ email: 'bob@example.com' }) })).status).toBe(404);
  });
});
