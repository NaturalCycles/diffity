import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { CommentThread, RepoInfoResponse, Tour } from '@diffity/api';
import type { ReviewSessionRecord } from '../src/reviews.js';
import {
  fakeUiDir,
  login,
  makeFixture,
  removeDir,
  startFakeGitHub,
  startTestServer,
  tempDir,
  type FakeGitHub,
  type Fixture,
  type TestServer,
} from './helpers.js';

let fixture: Fixture;
let github: FakeGitHub;
let dataDir: string;
let server: TestServer;
let aliceCookie: string;
let bobCookie: string;
let aliceId: string;
let bobId: string;
let session: ReviewSessionRecord;
let prSession: ReviewSessionRecord;
let bobSession: ReviewSessionRecord;

async function api(
  path: string,
  init: RequestInit & { cookie?: string; json?: unknown } = {},
): Promise<{ status: number; body: any; headers: Headers }> {
  const headers = new Headers(init.headers);
  if (init.cookie) {
    headers.set('cookie', init.cookie);
  }
  if (init.json !== undefined) {
    headers.set('Content-Type', 'application/json');
  }
  if (init.method && init.method !== 'GET' && !headers.has('Sec-Fetch-Site')) {
    headers.set('Sec-Fetch-Site', 'same-origin');
  }
  const res = await fetch(`${server.base}${path}`, {
    ...init,
    headers,
    redirect: 'manual',
    body: init.json !== undefined ? JSON.stringify(init.json) : init.body,
  });
  const text = await res.text();
  let body: unknown = text;
  try {
    body = JSON.parse(text);
  } catch {
    // An HTML page or a plain answer.
  }
  return { status: res.status, body, headers: res.headers };
}

beforeAll(async () => {
  fixture = makeFixture();
  github = await startFakeGitHub([
    {
      owner: 'acme',
      name: 'widgets',
      private: false,
      tokens: [],
      pulls: { 1: { title: 'Change line ten', baseSha: fixture.mainTip, headSha: fixture.head1 } },
    },
  ]);
  dataDir = tempDir('http');
  server = await startTestServer(dataDir, github.url, { remoteUrl: fixture.remoteUrl, uiDir: fakeUiDir(dataDir) });
  aliceCookie = await login(server.base, 'alice@example.com');
  bobCookie = await login(server.base, 'bob@example.com');
  aliceId = server.users.findOrCreate('alice@example.com').id;
  bobId = server.users.findOrCreate('bob@example.com').id;
  session = (await server.service.createSession(aliceId, { repo: 'acme/widgets', base: fixture.base, head: fixture.head2 })).session;
  prSession = (await server.service.createSession(aliceId, { repo: 'acme/widgets', pr: 1 })).session;
  bobSession = (await server.service.createSession(bobId, { repo: 'acme/widgets', base: fixture.base, head: fixture.head1 })).session;
});

afterAll(async () => {
  await server.close();
  await github.close();
  removeDir(fixture.root);
  removeDir(dataDir);
});

describe('web pages', () => {
  it('answers the health check without signing in', async () => {
    expect(await api('/healthz')).toMatchObject({ status: 200, body: { ok: true } });
  });

  it('sends a visitor to sign in, and back to where they were going', async () => {
    const res = await api('/');
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/login?next=%2F');
    const form = await api('/login?next=/settings');
    expect(form.body).toContain('name="next" value="/settings"');
    expect(form.headers.get('content-security-policy')).toContain("form-action 'self'");
  });

  it('refuses an email outside the allowed domain, a cross-site login, and an open redirect', async () => {
    const post = (email: string, next: string, site = 'same-origin') => fetch(`${server.base}/login`, {
      method: 'POST',
      redirect: 'manual',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Sec-Fetch-Site': site },
      body: new URLSearchParams({ email, next }).toString(),
    });
    expect((await post('eve@evil.io', '/')).status).toBe(403);
    expect((await post('alice@example.com', '/', 'cross-site')).status).toBe(403);
    const redirected = await post('alice@example.com', '//evil.io/steal');
    expect(redirected.status).toBe(303);
    expect(redirected.headers.get('location')).toBe('/');
    const cookie = redirected.headers.get('set-cookie')!;
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('SameSite=Lax');
    expect(cookie).not.toContain('Secure');
  });

  it('lists the signed-in user’s sessions only', async () => {
    const page = await api('/', { cookie: aliceCookie });
    expect(page.body).toContain(`/s/${session.id}/`);
    expect(page.body).toContain('#1 Change line ten');
    expect(page.body).not.toContain(bobSession.id);
  });

  it('keeps a pasted GitHub token encrypted, and removes it on request', async () => {
    expect((await api('/settings', { cookie: aliceCookie })).body).toContain('No token set');
    const save = await api('/settings/github-token', {
      method: 'POST',
      cookie: aliceCookie,
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'token=ghp_pasted',
    });
    expect(save.status).toBe(303);
    expect(server.users.gitHubToken(aliceId)).toBe('ghp_pasted');
    expect(JSON.stringify(server.store.all('SELECT github_token FROM users'))).not.toContain('ghp_pasted');
    expect((await api('/settings', { cookie: aliceCookie })).body).toContain('Your own token is set');
    await api('/settings/github-token', {
      method: 'POST',
      cookie: aliceCookie,
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'clear=1',
    });
    expect(server.users.gitHubToken(aliceId)).toBeNull();
  });

  it('signs out', async () => {
    const cookie = await login(server.base, 'carol@example.com');
    expect((await api('/', { cookie })).status).toBe(200);
    const out = await api('/logout', { method: 'POST', cookie });
    expect(out.status).toBe(303);
    expect((await api('/', { cookie })).status).toBe(302);
  });
});

describe('the review page', () => {
  it('serves the UI with its base injected, to its owner only', async () => {
    const page = await api(`/s/${session.id}/diff?ref=work`, { cookie: aliceCookie });
    expect(page.status).toBe(200);
    expect(page.body).toContain(`<head><script>window.__DIFFITY_BASE__="/s/${session.id}"</script>`);
    expect(page.headers.get('content-security-policy')).toContain("connect-src 'self'");
    expect((await api(`/s/${session.id}`, { cookie: aliceCookie })).status).toBe(200);

    expect((await api(`/s/${session.id}/`, { cookie: bobCookie })).status).toBe(404);
    expect((await api(`/s/${session.id.slice(0, 8)}/`, { cookie: aliceCookie })).status).toBe(404);
    const anonymous = await api(`/s/${session.id}/`);
    expect(anonymous.status).toBe(302);
    expect(anonymous.headers.get('location')).toBe(`/login?next=${encodeURIComponent(`/s/${session.id}/`)}`);
  });

  it('serves the build’s assets to anyone', async () => {
    expect((await api('/assets/app.js')).status).toBe(200);
    expect((await api('/favicon.svg')).status).toBe(200);
  });
});

describe('the UI API', () => {
  const base = () => `/s/${session.id}/api`;

  it('needs a signed-in owner', async () => {
    expect((await api(`${base()}/info`)).status).toBe(401);
    expect((await api(`${base()}/info`, { cookie: bobCookie })).status).toBe(404);
    expect((await api(`${base()}/threads?session=${session.id}`, { cookie: bobCookie })).status).toBe(404);
    expect((await api(`${base()}/diff`, { cookie: bobCookie })).status).toBe(404);
  });

  it('describes the session as a hosted review of fixed commits', async () => {
    const info = (await api(`${base()}/info`, { cookie: aliceCookie })).body as RepoInfoResponse;
    expect(info).toMatchObject({
      name: 'acme/widgets',
      sessionId: session.id,
      capabilities: { reviews: true, revert: false, staleness: false },
      github: null,
      editor: null,
      hosted: true,
    });
    const pr = (await api(`/s/${prSession.id}/api/info`, { cookie: aliceCookie })).body as RepoInfoResponse;
    expect(pr).toMatchObject({ github: { owner: 'acme', repo: 'widgets' }, branch: 'feature', description: '#1 Change line ten' });
  });

  it('answers the diff, one file of it, and a fingerprint that never moves', async () => {
    const diff = await api(`${base()}/diff?ref=work`, { cookie: aliceCookie });
    expect(diff.body.files.map((f: { newPath: string }) => f.newPath).sort()).toEqual(['added.ts', 'new-name.ts', 'src.ts']);
    expect(diff.body.suppressed).toBeNull();
    expect((await api(`${base()}/diff?whitespace=hide`, { cookie: aliceCookie })).body.suppressed).toEqual({ files: 0, lines: 0 });
    const one = await api(`${base()}/diff/file?path=added.ts`, { cookie: aliceCookie });
    expect(one.body.file.newPath).toBe('added.ts');
    expect((await api(`${base()}/diff/file?path=README.md`, { cookie: aliceCookie })).body).toEqual({ file: null });
    expect((await api(`${base()}/diff/file`, { cookie: aliceCookie })).status).toBe(400);
    const a = (await api(`${base()}/diff-fingerprint`, { cookie: aliceCookie })).body;
    const b = (await api(`${base()}/diff-fingerprint`, { cookie: aliceCookie })).body;
    expect(a).toEqual(b);
  });

  it('answers file content at the base, and at the head through the tree route', async () => {
    const old = await api(`${base()}/file/src.ts?ref=work`, { cookie: aliceCookie });
    expect(old.body.content[9]).toBe('line 10 of the widget');
    expect(old.body.content).toHaveLength(30);
    expect((await api(`${base()}/file/added.ts`, { cookie: aliceCookie })).status).toBe(404);
    expect((await api(`${base()}/file/added.ts?side=new`, { cookie: aliceCookie })).body.content).toEqual(['export const added = 2;']);
    expect((await api(`${base()}/tree/file/${encodeURIComponent('src.ts')}`, { cookie: aliceCookie })).body.content[12])
      .toBe('line 10 changed by the feature');
    expect((await api(`${base()}/file/..%2F..%2Fetc%2Fpasswd`, { cookie: aliceCookie })).status).toBe(404);
  });

  it('keeps comments as the UI expects them, authored by the signed-in user', async () => {
    const created = await api(`${base()}/threads`, {
      method: 'POST',
      cookie: aliceCookie,
      json: {
        sessionId: session.id, filePath: 'src.ts', side: 'new', startLine: 13, endLine: 13,
        body: 'Looks odd', author: { name: 'Mallory', type: 'agent' }, anchorContent: 'line 10 changed by the feature',
      },
    });
    expect(created.status).toBe(200);
    const thread = created.body as CommentThread;
    expect(thread.comments[0].author).toEqual({ name: 'alice', type: 'user' });
    expect(thread.comments[0].liveRequestedAt).toBeNull();

    const reply = await api(`${base()}/threads/${thread.id}/reply`, {
      method: 'POST', cookie: aliceCookie, json: { body: 'More', author: { name: 'x', type: 'user' }, kind: 'aside' },
    });
    expect(reply.body).toMatchObject({ body: 'More', kind: 'aside', author: { name: 'alice', type: 'user' } });

    expect((await api(`${base()}/threads/${thread.id}/status`, {
      method: 'PATCH', cookie: aliceCookie, json: { status: 'resolved', summary: 'Done' },
    })).status).toBe(200);
    expect((await api(`${base()}/threads?session=${session.id}&status=resolved`, { cookie: aliceCookie })).body).toHaveLength(1);
    expect((await api(`${base()}/threads?status=bogus`, { cookie: aliceCookie })).status).toBe(400);

    const commentId = thread.comments[0].id;
    expect((await api(`${base()}/comments/${commentId}`, { method: 'PATCH', cookie: aliceCookie, json: { body: 'Edited' } })).status).toBe(200);
    const listed = (await api(`${base()}/threads?session=${session.id}`, { cookie: aliceCookie })).body as CommentThread[];
    expect(listed[0].comments.map(c => c.body)).toEqual(['Edited', 'More', 'Done']);
    expect(listed[0].comments[2].author).toEqual({ name: 'System', type: 'user' });

    expect((await api(`${base()}/comments/${commentId}`, { method: 'DELETE', cookie: aliceCookie })).status).toBe(200);
    expect((await api(`${base()}/threads/${thread.id}`, { method: 'DELETE', cookie: aliceCookie })).status).toBe(200);
    expect((await api(`${base()}/threads?session=${session.id}`, { cookie: aliceCookie })).body).toEqual([]);
  });

  it('refuses a body that names another session, a malformed one, and invalid JSON', async () => {
    const wrong = await api(`${base()}/threads`, {
      method: 'POST', cookie: aliceCookie,
      json: { sessionId: prSession.id, filePath: 'a', side: 'new', startLine: 1, endLine: 1, body: 'x', author: { name: 'a', type: 'user' } },
    });
    expect(wrong.status).toBe(400);
    expect((await api(`${base()}/threads?session=${prSession.id}`, { cookie: aliceCookie })).status).toBe(400);
    const malformed = await api(`${base()}/threads`, { method: 'POST', cookie: aliceCookie, json: { sessionId: session.id } });
    expect(malformed.status).toBe(400);
    expect(malformed.body.error).toContain('filePath');
    const invalid = await api(`${base()}/threads`, {
      method: 'POST', cookie: aliceCookie, headers: { 'Content-Type': 'application/json' }, body: '{nope',
    });
    expect(invalid.status).toBe(400);
    expect(invalid.body.error).toBe('Request body must be valid JSON');
  });

  it('deletes every thread of the session and nothing else', async () => {
    const create = (sid: string) => api(`/s/${sid}/api/threads`, {
      method: 'POST', cookie: aliceCookie,
      json: { sessionId: sid, filePath: 'src.ts', side: 'new', startLine: 1, endLine: 1, body: 'x', author: { name: 'a', type: 'user' } },
    });
    await create(session.id);
    await create(prSession.id);
    expect((await api(`${base()}/threads`, { method: 'DELETE', cookie: aliceCookie, json: { sessionId: session.id } })).status).toBe(200);
    expect((await api(`${base()}/threads?session=${session.id}`, { cookie: aliceCookie })).body).toEqual([]);
    expect((await api(`/s/${prSession.id}/api/threads?session=${prSession.id}`, { cookie: aliceCookie })).body).toHaveLength(1);
  });

  it('keeps a thread, comment or tour of one session out of another’s URL', async () => {
    const thread = server.service.reviews.createThread({
      userId: aliceId, sessionId: prSession.id, filePath: 'src.ts', side: 'new', startLine: 1, endLine: 1,
      body: 'In the PR session', author: { name: 'a', type: 'agent' },
    });
    const tour = server.service.reviews.createTour(aliceId, prSession.id, 'Order', '');
    expect((await api(`${base()}/threads/${thread.id}/reply`, {
      method: 'POST', cookie: aliceCookie, json: { body: 'x', author: { name: 'a', type: 'user' } },
    })).status).toBe(404);
    expect((await api(`${base()}/threads/${thread.id}/status`, { method: 'PATCH', cookie: aliceCookie, json: { status: 'dismissed' } })).status).toBe(404);
    expect((await api(`${base()}/threads/${thread.id}`, { method: 'DELETE', cookie: aliceCookie })).status).toBe(404);
    expect((await api(`${base()}/comments/${thread.comments[0].id}`, { method: 'PATCH', cookie: aliceCookie, json: { body: 'x' } })).status).toBe(404);
    expect((await api(`${base()}/comments/${thread.comments[0].id}`, { method: 'DELETE', cookie: aliceCookie })).status).toBe(404);
    expect((await api(`${base()}/tours/${tour.id}`, { cookie: aliceCookie })).status).toBe(404);
    // And bob, through his own session, reaches none of it either.
    const bobBase = `/s/${bobSession.id}/api`;
    expect((await api(`${bobBase}/threads/${thread.id}`, { method: 'DELETE', cookie: bobCookie })).status).toBe(404);
    expect((await api(`${bobBase}/tours/${tour.id}`, { cookie: bobCookie })).status).toBe(404);
    expect(server.service.reviews.getThread(aliceId, thread.id)?.status).toBe('open');
  });

  it('lists tours and serves one', async () => {
    const tour = server.service.reviews.createTour(aliceId, session.id, 'Reading order', 'why');
    server.service.reviews.addTourStep(aliceId, tour.id, { filePath: 'src.ts', startLine: 10, endLine: 10, body: 'b', annotation: 'a' });
    const listed = (await api(`${base()}/tours?session=${session.id}`, { cookie: aliceCookie })).body as Tour[];
    expect(listed.map(t => t.topic)).toEqual(['Reading order']);
    expect(((await api(`${base()}/tours/${tour.id}`, { cookie: aliceCookie })).body as Tour).steps).toHaveLength(1);
  });

  it('answers the live, presence and GitHub routes the page polls', async () => {
    expect((await api(`${base()}/live/status?ref=work`, { cookie: aliceCookie })).body).toMatchObject({ enabled: false, listening: false });
    expect((await api(`${base()}/viewer`, { method: 'POST', cookie: aliceCookie })).body).toEqual({ ok: true });
    expect((await api(`${base()}/viewer/gone`, { method: 'POST', cookie: aliceCookie })).body).toEqual({ ok: true });
    expect((await api(`${base()}/github/details`, { cookie: aliceCookie })).body).toBeNull();
    expect((await api(`/s/${prSession.id}/api/github/details`, { cookie: aliceCookie })).body).toMatchObject({
      prNumber: 1, prTitle: 'Change line ten', headSha: fixture.head1,
    });
    expect((await api(`${base()}/github/create-review`, { method: 'POST', cookie: aliceCookie, json: {} })).status).toBe(501);
    expect((await api(`${base()}/revert-file`, { method: 'POST', cookie: aliceCookie, json: {} })).status).toBe(404);
  });

  it('refuses a write from another site', async () => {
    const forged = (headers: Record<string, string>) => api(`${base()}/threads`, {
      method: 'POST', cookie: aliceCookie, headers,
      json: { sessionId: session.id, filePath: 'src.ts', side: 'new', startLine: 1, endLine: 1, body: 'x', author: { name: 'a', type: 'user' } },
    });
    expect((await forged({ 'Sec-Fetch-Site': 'cross-site' })).status).toBe(403);
    expect((await forged({ 'Sec-Fetch-Site': 'same-origin', Origin: 'https://evil.example' })).status).toBe(403);
    expect((await forged({ 'Sec-Fetch-Site': 'same-origin', Origin: server.base })).status).toBe(200);
  });

  it('answers anything else with a JSON 404', async () => {
    expect(await api('/nope')).toMatchObject({ status: 404, body: { error: 'Not found' } });
  });
});
