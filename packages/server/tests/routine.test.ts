import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LiveStatusResponse } from '@diffity/api';
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

interface Fired {
  url: string;
  headers: Headers;
  text: string;
}

let fixture: Fixture;
let github: FakeGitHub;
let dataDir: string;
let server: TestServer;
let aliceCookie: string;
let bobCookie: string;
let aliceId: string;
let bobId: string;
let fired: Fired[];
let answer: number;

const routineFetch = (async (input: string | URL | Request, init?: RequestInit) => {
  fired.push({ url: String(input), headers: new Headers(init?.headers), text: (JSON.parse(String(init?.body)) as { text: string }).text });
  return new Response('{}', { status: answer });
}) as typeof fetch;

const sameSite = (cookie: string) => ({ cookie, 'Sec-Fetch-Site': 'same-origin' });

const createAndReview = (cookie: string) => fetch(`${server.base}/sessions`, {
  method: 'POST',
  redirect: 'manual',
  headers: { ...sameSite(cookie), 'Content-Type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams({ repo: 'acme/widgets', pr: '1', review: '1' }).toString(),
});

const shasSession = async (userId: string, base: string, head: string) =>
  (await server.service.createSession(userId, { repo: 'acme/widgets', base, head })).session;

const ask = (session: string, cookie = aliceCookie) => fetch(`${server.base}/s/${session}/api/threads`, {
  method: 'POST',
  headers: { ...sameSite(cookie), 'Content-Type': 'application/json' },
  body: JSON.stringify({ sessionId: session, filePath: 'src.ts', side: 'new', startLine: 10, endLine: 10, body: 'Why?', author: { name: 'You', type: 'user' }, ask: true }),
});

const firedAt = async (session: string) =>
  (await server.db.one<{ routine_fired_at: number | null }>('SELECT routine_fired_at FROM sessions WHERE id = $1', [session]))!.routine_fired_at;

/** `diffity session <id> repo <slug> pr <n> base <sha> head <sha> kind <kind> url <url> token <token>` */
const fields = (text: string): Record<string, string> => {
  const words = text.split(' ');
  expect(words[0]).toBe('diffity');
  const pairs: Record<string, string> = {};
  for (let i = 1; i < words.length; i += 2) {
    pairs[words[i]] = words[i + 1];
  }
  return pairs;
};

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
  dataDir = tempDir('routine');
  server = await startTestServer(dataDir, github.url, { remoteUrl: fixture.remoteUrl, uiDir: fakeUiDir(dataDir), routineFetch });
  aliceCookie = await login(server.base, 'alice@example.com');
  bobCookie = await login(server.base, 'bob@example.com');
  aliceId = (await server.users.findOrCreate('alice@example.com')).id;
  bobId = (await server.users.findOrCreate('bob@example.com')).id;
  await server.users.setRoutine(aliceId, 'https://api.example/fire', 'sk-routine');
});

beforeEach(() => {
  fired = [];
  answer = 200;
});

afterAll(async () => {
  await server.close();
  await github.close();
  removeDir(fixture.root);
  removeDir(dataDir);
});

describe('calling the routine', () => {
  it('fires once for a session created and reviewed from the page, with a token for that session only', async () => {
    const created = await createAndReview(aliceCookie);
    expect(created.status).toBe(303);
    const session = /^\/s\/([^/]+)\/$/.exec(created.headers.get('location')!)![1];

    expect(fired).toHaveLength(1);
    const [call] = fired;
    expect(call.url).toBe('https://api.example/fire');
    expect(call.headers.get('authorization')).toBe('Bearer sk-routine');
    expect(call.headers.get('anthropic-beta')).toBe('experimental-cc-routine-2026-04-01');
    expect(call.headers.get('anthropic-version')).toBe('2023-06-01');
    expect(call.headers.get('content-type')).toBe('application/json');
    expect(call.text).not.toContain('\n');
    const payload = fields(call.text);
    expect(payload).toEqual({
      session,
      repo: 'acme/widgets',
      pr: '1',
      base: fixture.base,
      head: fixture.head1,
      kind: 'review',
      url: `${server.base}/s/${session}/`,
      token: expect.any(String),
    });
    expect(await server.live.verifySessionToken(payload.token)).toMatchObject({ userId: aliceId, sessionId: session });

    const again = await fetch(`${server.base}/sessions/${session}/review-request`, { method: 'POST', redirect: 'manual', headers: sameSite(aliceCookie) });
    expect(again.status).toBe(303);
    const fromPage = await fetch(`${server.base}/s/${session}/api/review-request`, { method: 'POST', headers: sameSite(aliceCookie) });
    expect(fromPage.status).toBe(200);
    expect(fired).toHaveLength(1);
  });

  it('fires for a question nobody is listening for, and the page says the agent was called', async () => {
    const session = await shasSession(aliceId, fixture.mainTip, fixture.head1);
    const status = async () =>
      (await fetch(`${server.base}/s/${session.id}/api/live/status`, { headers: { cookie: aliceCookie } })).json() as Promise<LiveStatusResponse>;
    expect((await status()).calledAt).toBeNull();

    expect((await ask(session.id)).status).toBe(200);
    expect(fired).toHaveLength(1);
    expect(fields(fired[0].text)).toMatchObject({ session: session.id, pr: '-', base: fixture.mainTip, head: fixture.head1, kind: 'ask' });
    const after = await status();
    expect(after.listening).toBe(false);
    expect(Date.now() - Date.parse(after.calledAt!)).toBeLessThan(5000);

    expect((await ask(session.id)).status).toBe(200);
    expect(fired).toHaveLength(1);
  });

  it('does not fire for a question an agent is listening for', async () => {
    const session = await shasSession(aliceId, fixture.base, fixture.head2);
    await server.live.recordPoll({ userId: aliceId, sessionId: session.id });
    expect((await ask(session.id)).status).toBe(200);
    expect(fired).toHaveLength(0);
    expect(await firedAt(session.id)).toBeNull();
  });

  it('answers the request as usual when the routine fails, and lets the next one try again', async () => {
    const session = await shasSession(aliceId, fixture.base, fixture.mainTip);
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      answer = 500;
      expect((await ask(session.id)).status).toBe(200);
      expect(fired).toHaveLength(1);
      expect(await firedAt(session.id)).toBeNull();
      expect(errors).toHaveBeenCalledWith(`routine fire failed for session ${session.id}: 500`);

      answer = 200;
      expect((await ask(session.id)).status).toBe(200);
      expect(fired).toHaveLength(2);
      expect(await firedAt(session.id)).not.toBeNull();
    } finally {
      errors.mockRestore();
    }
  });

  it('fires nothing for a user without a routine', async () => {
    const created = await createAndReview(bobCookie);
    expect(created.status).toBe(303);
    const session = await shasSession(bobId, fixture.base, fixture.head1);
    expect((await ask(session.id, bobCookie)).status).toBe(200);
    expect(fired).toHaveLength(0);
    expect(await firedAt(session.id)).toBeNull();
  });
});
