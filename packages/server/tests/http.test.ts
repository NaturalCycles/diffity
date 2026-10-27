import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { CommentThread, RepoInfoResponse, Tour } from '@diffity/api';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ReviewSessionRecord } from '../src/reviews.js';
import {
  fakeUiDir,
  git,
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
let pr2Head: string;

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
  git(fixture.work, ['checkout', '-b', 'second', fixture.head1]);
  writeFileSync(join(fixture.work, 'second.ts'), 'export const second = 2;\n');
  git(fixture.work, ['add', '.']);
  git(fixture.work, ['commit', '-m', 'second pull request']);
  pr2Head = git(fixture.work, ['rev-parse', 'HEAD']);
  git(fixture.work, ['checkout', 'main']);
  git(fixture.work, ['push', join(fixture.remotes, 'acme', 'widgets.git'), `${pr2Head}:refs/pull/2/head`]);
  github = await startFakeGitHub([
    {
      owner: 'acme',
      name: 'widgets',
      private: false,
      tokens: [],
      pulls: {
        1: { title: 'Change line ten', baseSha: fixture.mainTip, headSha: fixture.head1 },
        2: { title: 'Rename a file', baseSha: fixture.mainTip, headSha: pr2Head },
      },
    },
  ]);
  dataDir = tempDir('http');
  server = await startTestServer(dataDir, github.url, { remoteUrl: fixture.remoteUrl, uiDir: fakeUiDir(dataDir) });
  aliceCookie = await login(server.base, 'alice@example.com');
  bobCookie = await login(server.base, 'bob@example.com');
  aliceId = (await server.users.findOrCreate('alice@example.com')).id;
  bobId = (await server.users.findOrCreate('bob@example.com')).id;
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
    expect(await server.users.gitHubToken(aliceId)).toBe('ghp_pasted');
    expect(JSON.stringify(await server.db.query('SELECT github_token FROM users'))).not.toContain('ghp_pasted');
    expect((await api('/settings', { cookie: aliceCookie })).body).toContain('Your own token is set');
    await api('/settings/github-token', {
      method: 'POST',
      cookie: aliceCookie,
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'clear=1',
    });
    expect(await server.users.gitHubToken(aliceId)).toBeNull();
  });

  it('keeps the routine’s key encrypted and never shows it, keeps it on a save without one, and removes both on request', async () => {
    const save = (body: string) => api('/settings/routine', {
      method: 'POST',
      cookie: aliceCookie,
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    });
    expect((await api('/settings', { cookie: aliceCookie })).body).toContain('No key yet');
    expect((await save('url=http%3A%2F%2Finsecure.example%2Ffire&key=sk-routine')).status).toBe(400);
    expect(await server.users.routine(aliceId)).toBeNull();

    const saved = await save('url=+https%3A%2F%2Fapi.example%2Ffire+&key=sk-routine');
    expect(saved.status).toBe(303);
    expect(saved.headers.get('location')).toBe('/settings');
    expect(await server.users.routine(aliceId)).toEqual({ url: 'https://api.example/fire', key: 'sk-routine' });
    expect(JSON.stringify(await server.db.query('SELECT routine_key FROM users'))).not.toContain('sk-routine');
    const settings = (await api('/settings', { cookie: aliceCookie })).body as string;
    expect(settings).toContain('Key is set');
    expect(settings).toContain('value="https://api.example/fire"');
    expect(settings).not.toContain('sk-routine');
    expect(await server.users.routine(bobId)).toBeNull();

    await save('url=https%3A%2F%2Fapi.example%2Fother&key=');
    expect(await server.users.routine(aliceId)).toEqual({ url: 'https://api.example/other', key: 'sk-routine' });

    await save('clear=1');
    expect(await server.users.routine(aliceId)).toBeNull();
    expect(await server.users.routineSettings(aliceId)).toEqual({ url: null, keySet: false });
  });

  it('signs out', async () => {
    const cookie = await login(server.base, 'carol@example.com');
    expect((await api('/', { cookie })).status).toBe(200);
    const out = await api('/logout', { method: 'POST', cookie });
    expect(out.status).toBe(303);
    expect((await api('/', { cookie })).status).toBe(302);
  });
});

describe('pull requests awaiting review', () => {
  const form = (path: string, body: Record<string, string>, cookie: string, headers: Record<string, string> = {}) => api(path, {
    method: 'POST',
    cookie,
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...headers },
    body: new URLSearchParams(body).toString(),
  });

  it('asks the user to connect GitHub when there is nothing to ask with', async () => {
    const page = await api('/', { cookie: aliceCookie });
    expect(page.body).toContain('Awaiting your review');
    expect(page.body).toContain('Connect GitHub on Settings</a> to see pull requests waiting for your review');
    expect(page.body).toContain('Your review sessions');
  });

  it('lists them, linking an existing session and offering to create one, minus what the filters hide', async () => {
    github.reviewRequests['alice-token'] = [
      { owner: 'acme', repo: 'widgets', number: 1, title: 'Change line ten', author: 'octocat', updatedAt: '2026-10-03T09:15:00Z' },
      { owner: 'acme', repo: 'widgets', number: 2, title: 'Rename a file', author: 'carol', updatedAt: '2026-10-02T09:00:00Z' },
      { owner: 'acme', repo: 'widgets', number: 3, title: 'Release 1.2', author: 'bot', updatedAt: '2026-10-01T09:00:00Z' },
    ];
    await server.users.setGitHubToken(aliceId, 'alice-token');
    await server.users.setSettings(aliceId, { skipTitles: ['release'], includeDrafts: false });
    try {
      const page = (await api('/', { cookie: aliceCookie })).body as string;
      expect(page).toContain('<a href="https://github.com/acme/widgets/pull/1">acme/widgets#1</a>');
      expect(page).toContain(`<a href="/s/${prSession.id}/" target="_blank" rel="noopener">open · ${fixture.head1.slice(0, 7)}</a>`);
      expect(page).toContain('2026-10-03 09:15');
      expect(page).toMatch(/action="\/sessions" target="_blank">\s*<input type="hidden" name="repo" value="acme\/widgets">\s*<input type="hidden" name="pr" value="2">/);
      expect(page).not.toContain('Release 1.2');
      expect(page).toContain('(1 hidden by your');

      await server.users.setSettings(aliceId, { skipTitles: ['release', 'rename', 'change'], includeDrafts: false });
      const empty = (await api('/', { cookie: aliceCookie })).body as string;
      expect(empty).toContain('Nothing is waiting for your review. <span class="muted">(3 hidden by your');
    } finally {
      await server.users.setGitHubToken(aliceId, null);
      await server.users.setSettings(aliceId, { skipTitles: [], includeDrafts: false });
    }
  });

  it('offers to hand a pull request to the agent when a routine is configured, with nobody listening', async () => {
    github.reviewRequests['alice-token-routine'] = [
      { owner: 'acme', repo: 'widgets', number: 1, title: 'Change line ten', author: 'octocat', updatedAt: '2026-10-03T09:15:00Z' },
      { owner: 'acme', repo: 'widgets', number: 2, title: 'Rename a file', author: 'carol', updatedAt: '2026-10-02T09:00:00Z' },
    ];
    await server.users.setGitHubToken(aliceId, 'alice-token-routine');
    const userStatus = async () => (await api('/api/live/status', { cookie: aliceCookie })).body;
    const sessionStatus = async () => (await api(`/s/${session.id}/api/live/status`, { cookie: aliceCookie })).body;
    try {
      const without = (await api('/', { cookie: aliceCookie })).body as string;
      expect(without).not.toContain('Create and review');
      expect(without).not.toContain('<button type="submit">review</button>');
      expect(without).toContain('<button type="submit">Create session</button>');
      expect(await userStatus()).toMatchObject({ listening: false, routine: false });
      expect(await sessionStatus()).toMatchObject({ listening: false, routine: false });

      await server.users.setRoutine(aliceId, 'https://api.example/fire', 'sk-routine');
      const reachable = (await api('/', { cookie: aliceCookie })).body as string;
      expect(reachable).not.toContain('Agent listening');
      expect(reachable).toMatch(/name="pr" value="2">\s*<input type="hidden" name="review" value="1"><button type="submit">Create and review<\/button>/);
      expect(reachable).toContain(`action="/sessions/${prSession.id}/review-request"><button type="submit">review</button>`);
      expect(await userStatus()).toMatchObject({ listening: false, routine: true });
      expect(await sessionStatus()).toMatchObject({ listening: false, routine: true });
      expect((await api('/api/live/status', { cookie: bobCookie })).body.routine).toBe(false);
    } finally {
      await server.users.setRoutine(aliceId, null, null);
      await server.users.setGitHubToken(aliceId, null);
    }
  });

  it('lists the user’s own open pull requests, drafts marked, apart from the review queue', async () => {
    github.reviewRequests['alice-token-own'] = [
      { owner: 'acme', repo: 'widgets', number: 2, title: 'Rename a file', author: 'carol', updatedAt: '2026-10-02T09:00:00Z' },
    ];
    github.ownPulls['alice-token-own'] = [
      { owner: 'acme', repo: 'widgets', number: 1, title: 'Change line ten', author: 'alice', updatedAt: '2026-10-03T09:15:00Z' },
      { owner: 'acme', repo: 'widgets', number: 5, title: 'Work in progress', author: 'alice', draft: true, updatedAt: '2026-10-04T09:15:00Z' },
    ];
    await server.users.setGitHubToken(aliceId, 'alice-token-own');
    try {
      const page = (await api('/', { cookie: aliceCookie })).body as string;
      const review = page.slice(page.indexOf('Awaiting your review'), page.indexOf('Your open pull requests'));
      const own = page.slice(page.indexOf('Your open pull requests'), page.indexOf('Your review sessions'));
      expect(review).toContain('acme/widgets#2');
      expect(review).not.toContain('acme/widgets#1');
      expect(review).not.toContain('Work in progress');
      expect(own).toContain('acme/widgets#1');
      expect(own).toContain('Work in progress <span class="muted">draft</span>');
      expect(own).toContain(`<a href="/s/${prSession.id}/" target="_blank" rel="noopener">open · ${fixture.head1.slice(0, 7)}</a>`);
      expect(own).not.toContain('acme/widgets#2');
      expect(github.searches).toContain('is:pr is:open archived:false author:@me');

      github.ownPulls['alice-token-own-none'] = [];
      await server.users.setGitHubToken(aliceId, 'alice-token-own-none');
      expect((await api('/', { cookie: aliceCookie })).body).toContain('You have no open pull requests.');
    } finally {
      await server.users.setGitHubToken(aliceId, null);
    }
    expect((await api('/', { cookie: aliceCookie })).body).toContain('Connect GitHub on Settings</a> to see your open pull requests.');
  });

  it('opens sessions in a new tab, folds each section, and allows only its own script', async () => {
    github.reviewRequests['alice-token-tabs'] = [
      { owner: 'acme', repo: 'widgets', number: 2, title: 'Rename a file', author: 'carol', updatedAt: '2026-10-02T09:00:00Z' },
    ];
    await server.users.setGitHubToken(aliceId, 'alice-token-tabs');
    try {
      const res = await api('/', { cookie: aliceCookie });
      const page = res.body as string;
      expect(page).toContain(`<a href="/s/${session.id}/" target="_blank" rel="noopener">`);
      expect(page).not.toMatch(/<a href="\/s\/[^"]+\/">/);
      expect(page).toContain('<form class="inline" method="post" action="/sessions" target="_blank">');
      expect(page.match(/<details open><summary><h2>/g)).toHaveLength(3);
      expect(page).toContain('<script src="/sections.js"></script>');
      const csp = res.headers.get('content-security-policy')!;
      expect(csp).toContain("script-src 'self'");
      expect(csp).not.toMatch(/script-src[^;]*unsafe/);
      const script = await api('/sections.js');
      expect(script.headers.get('content-type')).toContain('javascript');
      expect(script.body).toContain('localStorage');
      expect((await api('/settings', { cookie: aliceCookie })).headers.get('content-security-policy')).not.toContain('script-src');
    } finally {
      await server.users.setGitHubToken(aliceId, null);
    }
  });

  it('saves the filters from the settings form, and only from this site', async () => {
    expect(await form('/settings/review-requests', { skipTitles: 'Bump ', includeDrafts: '1' }, aliceCookie, { 'Sec-Fetch-Site': 'cross-site' }))
      .toMatchObject({ status: 403 });
    expect(await server.users.settings(aliceId)).toEqual({ skipTitles: [], includeDrafts: false });

    const saved = await form('/settings/review-requests', { skipTitles: 'Bump \r\n\r\n release\nBump', includeDrafts: '1' }, aliceCookie);
    expect(saved.status).toBe(303);
    expect(saved.headers.get('location')).toBe('/settings');
    expect(await server.users.settings(aliceId)).toEqual({ skipTitles: ['Bump', 'release'], includeDrafts: true });
    const settings = (await api('/settings', { cookie: aliceCookie })).body as string;
    expect(settings).toContain('>Bump\nrelease</textarea>');
    expect(settings).toContain('value="1" checked>');

    await form('/settings/review-requests', { skipTitles: '' }, aliceCookie);
    expect(await server.users.settings(aliceId)).toEqual({ skipTitles: [], includeDrafts: false });
    expect(await server.users.settings(bobId)).toEqual({ skipTitles: [], includeDrafts: false });
  });

  it('creates a pull request session from the button, for the signed-in user only', async () => {
    expect(await form('/sessions', { repo: 'acme/widgets', pr: '2' }, aliceCookie, { 'Sec-Fetch-Site': 'cross-site' }))
      .toMatchObject({ status: 403 });
    const anonymous = await api('/sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'repo=acme%2Fwidgets&pr=2',
    });
    expect(anonymous.status).toBe(302);
    expect((await server.service.reviews.listSessions(aliceId)).some(s => s.prNumber === 2)).toBe(false);

    const created = await form('/sessions', { repo: 'acme/widgets', pr: '2' }, aliceCookie);
    expect(created.status).toBe(303);
    const id = /^\/s\/([^/]+)\/$/.exec(created.headers.get('location') ?? '')?.[1];
    expect(await server.service.reviews.getSession(aliceId, id!)).toMatchObject({ kind: 'pr', prNumber: 2, headSha: pr2Head });
    expect(await server.service.reviews.getSession(bobId, id!)).toBeNull();
    expect((await api(`/s/${id}/`, { cookie: bobCookie })).status).toBe(404);

    const bobs = await form('/sessions', { repo: 'acme/widgets', pr: '2' }, bobCookie);
    expect(bobs.headers.get('location')).not.toBe(created.headers.get('location'));
  });

  it('says why no session was created, with a way back', async () => {
    const missing = await form('/sessions', { repo: 'acme/nothing', pr: '1' }, aliceCookie);
    expect(missing.status).toBe(404);
    expect(missing.body).toContain('acme/nothing is not readable without GitHub access');
    expect(missing.body).toContain('<a href="/">Back to your sessions</a>');
    expect((await form('/sessions', { repo: 'acme/widgets', pr: 'x' }, aliceCookie)).status).toBe(400);
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

  it('describes the session', async () => {
    const info = (await api(`${base()}/info`, { cookie: aliceCookie })).body as RepoInfoResponse;
    expect(info).toMatchObject({
      name: 'acme/widgets',
      sessionId: session.id,
      github: null,
    });
    const pr = (await api(`/s/${prSession.id}/api/info`, { cookie: aliceCookie })).body as RepoInfoResponse;
    expect(pr).toMatchObject({ github: { owner: 'acme', repo: 'widgets' }, branch: 'feature', description: '#1 Change line ten' });
  });

  it('answers the diff, and what hiding whitespace suppressed', async () => {
    const diff = await api(`${base()}/diff?ref=work`, { cookie: aliceCookie });
    expect(diff.body.files.map((f: { newPath: string }) => f.newPath).sort()).toEqual(['added.ts', 'new-name.ts', 'src.ts']);
    expect(diff.body.suppressed).toBeNull();
    expect((await api(`${base()}/diff?whitespace=hide`, { cookie: aliceCookie })).body.suppressed).toEqual({ files: 0, lines: 0 });
  });

  it('answers file content at the base', async () => {
    const old = await api(`${base()}/file/src.ts?ref=work`, { cookie: aliceCookie });
    expect(old.body.content[9]).toBe('line 10 of the widget');
    expect(old.body.content).toHaveLength(30);
    expect((await api(`${base()}/file/added.ts`, { cookie: aliceCookie })).status).toBe(404);
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
    const thread = await server.service.reviews.createThread({
      userId: aliceId, sessionId: prSession.id, filePath: 'src.ts', side: 'new', startLine: 1, endLine: 1,
      body: 'In the PR session', author: { name: 'a', type: 'agent' },
    });
    await server.service.reviews.createTour(aliceId, prSession.id, 'Order', '');
    expect((await api(`${base()}/threads/${thread.id}/reply`, {
      method: 'POST', cookie: aliceCookie, json: { body: 'x', author: { name: 'a', type: 'user' } },
    })).status).toBe(404);
    expect((await api(`${base()}/threads/${thread.id}/status`, { method: 'PATCH', cookie: aliceCookie, json: { status: 'dismissed' } })).status).toBe(404);
    expect((await api(`${base()}/threads/${thread.id}`, { method: 'DELETE', cookie: aliceCookie })).status).toBe(404);
    expect((await api(`${base()}/comments/${thread.comments[0].id}`, { method: 'PATCH', cookie: aliceCookie, json: { body: 'x' } })).status).toBe(404);
    expect((await api(`${base()}/comments/${thread.comments[0].id}`, { method: 'DELETE', cookie: aliceCookie })).status).toBe(404);
    expect((await api(`${base()}/tours?session=${session.id}`, { cookie: aliceCookie })).body).toEqual([]);
    // And bob, through his own session, reaches none of it either.
    const bobBase = `/s/${bobSession.id}/api`;
    expect((await api(`${bobBase}/threads/${thread.id}`, { method: 'DELETE', cookie: bobCookie })).status).toBe(404);
    expect((await api(`${bobBase}/tours?session=${bobSession.id}`, { cookie: bobCookie })).body).toEqual([]);
    expect((await server.service.reviews.getThread(aliceId, thread.id))?.status).toBe('open');
  });

  it('lists tours with their steps', async () => {
    const tour = await server.service.reviews.createTour(aliceId, session.id, 'Reading order', 'why');
    await server.service.reviews.addTourStep(aliceId, tour.id, { filePath: 'src.ts', startLine: 10, endLine: 10, body: 'b', annotation: 'a' });
    const listed = (await api(`${base()}/tours?session=${session.id}`, { cookie: aliceCookie })).body as Tour[];
    expect(listed.map(t => t.topic)).toEqual(['Reading order']);
    expect(listed[0].steps).toHaveLength(1);
  });

  it('answers the GitHub details of a pull request session only', async () => {
    expect((await api(`${base()}/github/details`, { cookie: aliceCookie })).body).toBeNull();
    expect((await api(`/s/${prSession.id}/api/github/details`, { cookie: aliceCookie })).body).toMatchObject({
      prNumber: 1, prTitle: 'Change line ten', headSha: fixture.head1,
    });
    expect((await api(`${base()}/github/create-review`, { method: 'POST', cookie: aliceCookie, json: { event: 'COMMENT', body: 'x' } })).status)
      .toBe(400);
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
