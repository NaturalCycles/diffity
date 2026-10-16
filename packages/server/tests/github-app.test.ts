import { generateKeyPairSync, verify } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { GitHubApi } from '../src/github.js';
import { GitHubAppBot, appJwt } from '../src/github-app.js';
import { login, removeDir, startFakeGitHub, startTestServer, tempDir, type FakeGitHub, type TestServer } from './helpers.js';

let github: FakeGitHub;
let dataDir: string;
let server: TestServer;
let aliceCookie: string;
let bobCookie: string;
let aliceId: string;
const tokenRequests: Record<string, string>[] = [];
let issued = 0;
let refusing = false;

async function get(path: string, cookie: string): Promise<Response> {
  return fetch(`${server.base}${path}`, { headers: { cookie }, redirect: 'manual' });
}

async function connect(cookie: string): Promise<string> {
  const res = await get('/github/connect', cookie);
  expect(res.status).toBe(302);
  const location = new URL(res.headers.get('location')!);
  expect(location.origin + location.pathname).toBe(`${github.url}/login/oauth/authorize`);
  expect(location.searchParams.get('client_id')).toBe('Iv1.client');
  expect(location.searchParams.get('redirect_uri')).toBe(`${server.base}/github/callback`);
  return location.searchParams.get('state')!;
}

beforeAll(async () => {
  github = await startFakeGitHub([]);
  github.tokenEndpoint = params => {
    tokenRequests.push(Object.fromEntries(params));
    const good = params.get('code') === 'good-code' || (params.get('grant_type') === 'refresh_token' && !refusing);
    if (!good || params.get('client_secret') !== 'app-secret') {
      return { error: params.has('code') ? 'bad_verification_code' : 'bad_refresh_token' };
    }
    issued++;
    github.logins[`access-${issued}`] = 'alice-gh';
    return {
      access_token: `access-${issued}`,
      expires_in: 28800,
      refresh_token: `refresh-${issued}`,
      refresh_token_expires_in: 15811200,
    };
  };
  dataDir = tempDir('github-app');
  server = await startTestServer(dataDir, github.url, {}, {
    githubApp: { clientId: 'Iv1.client', clientSecret: 'app-secret', slug: 'diffity-nc', bot: null },
  });
  aliceCookie = await login(server.base, 'alice@example.com');
  bobCookie = await login(server.base, 'bob@example.com');
  aliceId = (await server.users.findOrCreate('alice@example.com')).id;
});

afterAll(async () => {
  await server.close();
  await github.close();
  removeDir(dataDir);
});

describe('connecting GitHub through the app', () => {
  it('offers to connect and to install the app, and no token form', async () => {
    const page = await (await get('/settings', aliceCookie)).text();
    expect(page).toContain('href="/github/connect"');
    expect(page).toContain(`${github.url}/apps/diffity-nc/installations/new`);
    expect(page).not.toContain('Personal access token');
    const paste = await fetch(`${server.base}/settings/github-token`, {
      method: 'POST',
      headers: { cookie: aliceCookie, 'Content-Type': 'application/x-www-form-urlencoded', 'Sec-Fetch-Site': 'same-origin' },
      body: 'token=ghp_x',
    });
    expect(paste.status).toBe(404);
  });

  it('completes only for the user who started it, once', async () => {
    const state = await connect(aliceCookie);
    expect((await get(`/github/callback?code=good-code&state=${state}`, bobCookie)).status).toBe(400);
    expect((await get(`/github/callback?code=good-code&state=${state}`, aliceCookie)).status).toBe(400);
    expect((await get('/github/callback?code=good-code', aliceCookie)).status).toBe(400);
    expect(issued).toBe(0);

    const denied = await connect(aliceCookie);
    const refused = await get(`/github/callback?code=wrong&state=${denied}`, aliceCookie);
    expect(refused.status).toBe(400);
    expect(await refused.text()).toContain('bad_verification_code');
  });

  it('stores the tokens encrypted and shows who is connected', async () => {
    const state = await connect(aliceCookie);
    const done = await get(`/github/callback?code=good-code&state=${state}`, aliceCookie);
    expect(done.status).toBe(302);
    expect(done.headers.get('location')).toBe('/settings');
    expect(tokenRequests.at(-1)).toMatchObject({ client_id: 'Iv1.client', code: 'good-code', redirect_uri: `${server.base}/github/callback` });

    expect(await server.githubApp!.tokenFor(aliceId)).toBe('access-1');
    expect(JSON.stringify(await server.db.query('SELECT * FROM users'))).not.toMatch(/access-1|refresh-1/);
    expect(await (await get('/settings', aliceCookie)).text()).toContain('Connected as <strong>alice-gh</strong>');
    expect((await get(`/github/callback?code=good-code&state=${state}`, aliceCookie)).status).toBe(400);
  });

  it('refreshes an expired token once however many ask, rotating both tokens', async () => {
    await server.db.query('UPDATE users SET github_access_expires_at = 0 WHERE id = $1', [aliceId]);
    const before = tokenRequests.length;
    const tokens = await Promise.all([server.githubApp!.tokenFor(aliceId), server.githubApp!.tokenFor(aliceId)]);
    expect(tokens).toEqual(['access-2', 'access-2']);
    expect(tokenRequests.slice(before)).toEqual([
      { client_id: 'Iv1.client', client_secret: 'app-secret', grant_type: 'refresh_token', refresh_token: 'refresh-1' },
    ]);
    expect(await server.githubApp!.tokenFor(aliceId)).toBe('access-2');
  });

  it('drops the connection when GitHub refuses the refresh', async () => {
    await server.db.query('UPDATE users SET github_access_expires_at = 0 WHERE id = $1', [aliceId]);
    refusing = true;
    try {
      expect(await server.githubApp!.tokenFor(aliceId)).toBeNull();
      expect(await server.githubApp!.connectedLogin(aliceId)).toBeNull();
    } finally {
      refusing = false;
    }
  });

  it('drops the connection when the refresh token itself has expired, without asking GitHub', async () => {
    const state = await connect(aliceCookie);
    await get(`/github/callback?code=good-code&state=${state}`, aliceCookie);
    await server.db.query('UPDATE users SET github_access_expires_at = 0, github_refresh_expires_at = 1 WHERE id = $1', [aliceId]);
    const before = tokenRequests.length;
    expect(await server.githubApp!.tokenFor(aliceId)).toBeNull();
    expect(tokenRequests.length).toBe(before);
  });

  it('disconnects', async () => {
    const state = await connect(aliceCookie);
    await get(`/github/callback?code=good-code&state=${state}`, aliceCookie);
    expect(await server.githubApp!.connectedLogin(aliceId)).toBe('alice-gh');
    const res = await fetch(`${server.base}/github/disconnect`, {
      method: 'POST', redirect: 'manual', headers: { cookie: aliceCookie, 'Sec-Fetch-Site': 'same-origin' },
    });
    expect(res.status).toBe(303);
    expect(await server.githubApp!.tokenFor(aliceId)).toBeNull();
    expect(await (await get('/settings', aliceCookie)).text()).toContain('Not connected');
  });
});

describe('the App acting as itself', () => {
  const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const bot = { appId: 5312078, privateKey: privateKey.export({ type: 'pkcs1', format: 'pem' }).toString() };

  function decode(part: string): Record<string, unknown> {
    return JSON.parse(Buffer.from(part, 'base64url').toString('utf8')) as Record<string, unknown>;
  }

  it('signs a JWT that verifies against the App key, issued a minute back and good for nine minutes', () => {
    const jwt = appJwt(bot, 1_700_000_000_500);
    const [header, claims, signature] = jwt.split('.');
    expect(decode(header)).toEqual({ alg: 'RS256', typ: 'JWT' });
    expect(decode(claims)).toEqual({ iat: 1_700_000_000 - 60, exp: 1_700_000_000 + 540, iss: 5312078 });
    expect(verify('RSA-SHA256', Buffer.from(`${header}.${claims}`), publicKey, Buffer.from(signature, 'base64url'))).toBe(true);
    const other = generateKeyPairSync('rsa', { modulusLength: 2048 }).publicKey;
    expect(verify('RSA-SHA256', Buffer.from(`${header}.${claims}`), other, Buffer.from(signature, 'base64url'))).toBe(false);
  });

  it('mints an installation token once however many ask, keeps it, and mints again shortly before it expires', async () => {
    github.installations['acme/widgets'] = 42;
    let now = Date.now();
    const app = new GitHubAppBot(bot, { api: new GitHubApi(github.url), slug: 'diffity', now: () => now });
    expect(app.login).toBe('diffity[bot]');
    const before = github.installationTokenRequests.length;

    const [first, second] = await Promise.all([app.installationToken('acme', 'widgets'), app.installationToken('Acme', 'Widgets')]);
    expect(second).toBe(first);
    expect(await app.installationToken('acme', 'widgets')).toBe(first);
    const minted = github.installationTokenRequests.slice(before);
    expect(minted).toHaveLength(1);
    expect(minted[0].installationId).toBe(42);
    const [header, claims, signature] = minted[0].jwt!.split('.');
    expect(verify('RSA-SHA256', Buffer.from(`${header}.${claims}`), publicKey, Buffer.from(signature, 'base64url'))).toBe(true);

    now += 30 * 60 * 1000;
    expect(await app.installationToken('acme', 'widgets')).toBe(first);
    expect(github.installationTokenRequests.length).toBe(before + 1);

    now += 30 * 60 * 1000;
    const renewed = await app.installationToken('acme', 'widgets');
    expect(renewed).not.toBe(first);
    expect(github.installationTokenRequests.length).toBe(before + 2);
  });

  it('says what GitHub answered when the App is not installed on the repository', async () => {
    const app = new GitHubAppBot(bot, { api: new GitHubApi(github.url), slug: null });
    expect(app.login).toBeNull();
    await expect(app.installationToken('acme', 'elsewhere')).rejects.toThrow(/404 for GET \/repos\/acme\/elsewhere\/installation: Not Found/);
  });
});
