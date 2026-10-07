import { execFile } from 'node:child_process';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { CommentThread, RepoInfoResponse } from '@diffity/api';
import { CLAIM_TTL_MS, LISTENING_WINDOW_MS, LIVE_TOKEN_TTL_MS, Live, REVIEW_STALE_MS } from '../src/live.js';
import { Reviews } from '../src/reviews.js';
import { Users } from '../src/users.js';
import type { Db } from '../src/db.js';
import {
  connectAgent,
  fakeUiDir,
  login,
  makeFixture,
  memoryDb,
  removeDir,
  startFakeGitHub,
  startTestServer,
  tempDir,
  type FakeGitHub,
  type Fixture,
  type TestServer,
} from './helpers.js';

describe('the request queue', () => {
  let db: Db;
  let live: Live;
  let reviews: Reviews;
  let alice: string;
  let bob: string;
  let sessionId: string;
  let otherSessionId: string;

  const question = async (session = sessionId, userId = alice) => {
    const thread = await reviews.createThread({
      userId, sessionId: session, filePath: 'a.ts', side: 'new', startLine: 1, endLine: 1, body: 'why?', author: { name: 'A', type: 'user' },
    });
    await live.ask(userId, session, thread.id, thread.comments[0].id);
    return thread;
  };

  const session = async (userId: string, head: string) => (await reviews.findOrCreateSession({
    userId, owner: 'acme', repo: 'widgets', kind: 'shas', prNumber: null, prMeta: null, baseSha: 'a'.repeat(40), headSha: head,
  })).session.id;

  beforeAll(async () => {
    db = await memoryDb();
    live = new Live(db);
    reviews = new Reviews(db);
    const users = new Users(db, Buffer.alloc(32));
    alice = (await users.findOrCreate('alice@example.com')).id;
    bob = (await users.findOrCreate('bob@example.com')).id;
    sessionId = await session(alice, 'b'.repeat(40));
    otherSessionId = await session(alice, 'c'.repeat(40));
  });

  afterAll(async () => {
    await db.close();
  });

  it('hands out the oldest request once, and again when its claim expires', async () => {
    const first = await question();
    const second = await question();
    const now = Date.now();

    expect((await live.claim(alice, sessionId, now))?.threadId).toBe(first.id);
    expect((await live.claim(alice, sessionId, now))?.threadId).toBe(second.id);
    expect(await live.claim(alice, sessionId, now)).toBeNull();

    const again = await live.claim(alice, sessionId, now + CLAIM_TTL_MS);
    expect(again?.threadId).toBe(first.id);
    await live.answer(alice, first.id);
    await live.answer(alice, second.id);
    expect(await live.claim(alice, sessionId, now + 3 * CLAIM_TTL_MS)).toBeNull();
  });

  it('hands a released claim out straight away', async () => {
    const thread = await question();
    const claimed = (await live.claim(alice, sessionId))!;
    await live.release(claimed.id);
    expect((await live.claim(alice, sessionId))?.id).toBe(claimed.id);
    await live.answer(alice, thread.id);
  });

  it('keeps each session’s and each user’s requests to themselves', async () => {
    const thread = await question();
    expect(await live.claim(alice, otherSessionId)).toBeNull();
    expect(await live.claim(bob, sessionId)).toBeNull();
    await live.answer(bob, thread.id);
    expect((await live.claim(alice, sessionId))?.threadId).toBe(thread.id);
    await live.answer(alice, thread.id);
  });

  it('wakes a waiting poll when a request is asked, and gives up at the deadline', async () => {
    const started = Date.now();
    expect(await live.next({ userId: alice, sessionId }, 200, new AbortController().signal)).toBeNull();
    expect(Date.now() - started).toBeGreaterThanOrEqual(190);

    const waiting = live.next({ userId: alice, sessionId }, 10_000, new AbortController().signal);
    await new Promise(resolve => setTimeout(resolve, 50));
    const thread = await question();
    const woken = Date.now();
    expect((await waiting)?.threadId).toBe(thread.id);
    expect(Date.now() - woken).toBeLessThan(2000);
    await live.answer(alice, thread.id);
  });

  it('stops waiting when the poller leaves', async () => {
    const gone = new AbortController();
    const waiting = live.next({ userId: alice, sessionId }, 10_000, gone.signal);
    gone.abort();
    expect(await waiting).toBeNull();
  });

  it('accepts a token only for its own session, and only until it expires', async () => {
    const { token } = await live.issueToken(alice, sessionId);
    expect(await live.verifyToken(token, sessionId)).toBe(alice);
    expect(await live.verifyToken(token, otherSessionId)).toBeNull();
    expect(await live.verifyToken(token, sessionId, Date.now() + LIVE_TOKEN_TTL_MS + 1)).toBeNull();
    expect(await live.verifyToken('made-up', sessionId)).toBeNull();
  });

  it('lets a user token wait on the whole queue or on any of the user’s sessions, and on nothing of anyone else’s', async () => {
    const { token } = await live.issueToken(alice, null);
    const bobs = await session(bob, 'd'.repeat(40));
    expect(await live.verifyToken(token, null)).toBe(alice);
    expect(await live.verifyToken(token, sessionId)).toBe(alice);
    expect(await live.verifyToken(token, otherSessionId)).toBe(alice);
    expect(await live.verifyToken(token, bobs)).toBeNull();
    expect(await live.verifyToken(token, null, Date.now() + LIVE_TOKEN_TTL_MS + 1)).toBeNull();

    const scoped = await live.issueToken(alice, sessionId);
    expect(await live.verifyToken(scoped.token, null)).toBeNull();
  });

  it('queues one review per session at a time, and review_done settles it', async () => {
    expect(await live.queueReview(alice, otherSessionId)).toBe(true);
    expect(await live.queueReview(alice, otherSessionId)).toBe(false);
    await live.answerReview(alice, otherSessionId);
    expect(await live.queueReview(alice, otherSessionId)).toBe(true);
    await live.answerReview(bob, otherSessionId);
    expect(await live.queueReview(alice, otherSessionId)).toBe(false);
    await live.answerReview(alice, otherSessionId);
  });

  it('hands the user’s queue out first come, across sessions, and keeps reviews from a session’s own poller', async () => {
    expect(await live.queueReview(alice, otherSessionId)).toBe(true);
    const asked = await question(sessionId);

    expect(await live.claim(bob, null)).toBeNull();
    expect((await live.claim(alice, otherSessionId))).toBeNull();
    const first = await live.claim(alice, null);
    expect(first).toMatchObject({ kind: 'review', sessionId: otherSessionId, threadId: null });
    expect((await live.claim(alice, null))?.threadId).toBe(asked.id);
    expect(await live.claim(alice, null)).toBeNull();

    await live.answer(alice, asked.id);
    await live.answerReview(alice, otherSessionId);
  });

  it('does not hand out again a review an agent has started, however long it takes', async () => {
    await live.queueReview(alice, otherSessionId);
    const now = Date.now();
    expect((await live.claim(alice, null, now))?.kind).toBe('review');
    expect((await live.claim(alice, null, now + CLAIM_TTL_MS))?.kind).toBe('review');
    await reviews.startReview(alice, otherSessionId, '');
    expect(await live.claim(alice, null, now + 3 * CLAIM_TTL_MS)).toBeNull();
    await reviews.finishReview(alice, otherSessionId);
    await live.answerReview(alice, otherSessionId);
    expect(await live.claim(alice, null, now + 5 * CLAIM_TTL_MS)).toBeNull();
  });

  it('wakes a poller on the user’s queue for a question or a review on any session', async () => {
    const waiting = live.next({ userId: alice, sessionId: null }, 10_000, new AbortController().signal);
    await new Promise(resolve => setTimeout(resolve, 50));
    await live.queueReview(alice, otherSessionId);
    expect((await waiting)?.kind).toBe('review');
    await live.answerReview(alice, otherSessionId);

    const again = live.next({ userId: alice, sessionId: null }, 10_000, new AbortController().signal);
    await new Promise(resolve => setTimeout(resolve, 50));
    const thread = await question(sessionId);
    expect((await again)?.threadId).toBe(thread.id);
    await live.answer(alice, thread.id);
  });

  it('counts a poll on the user’s queue as listening on every session, and only that one on the Sessions page', async () => {
    const now = Date.now();
    await live.recordPoll({ userId: alice, sessionId }, now);
    expect((await live.status(alice, sessionId, now)).listening).toBe(true);
    expect((await live.status(alice, otherSessionId, now)).listening).toBe(false);
    expect((await live.userStatus(alice, now)).listening).toBe(false);

    await live.recordPoll({ userId: alice, sessionId: null }, now);
    expect(await live.status(alice, otherSessionId, now)).toEqual({ listening: true, lastPollAt: new Date(now).toISOString() });
    expect((await live.userStatus(alice, now)).listening).toBe(true);
    expect((await live.userStatus(alice, now + LISTENING_WINDOW_MS)).listening).toBe(false);
    expect((await live.userStatus(bob, now)).listening).toBe(false);
  });
});

describe('over HTTP', () => {
  let fixture: Fixture;
  let github: FakeGitHub;
  let dataDir: string;
  let server: TestServer;
  let aliceCookie: string;
  let bobCookie: string;
  let aliceAccess: string;
  let alice: Client;
  let bob: Client;
  let sessionId: string;
  let otherSessionId: string;

  const mcpClient = async (accessToken: string): Promise<Client> => {
    const client = new Client({ name: 'test', version: '1.0.0' });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${server.base}/mcp`), {
      requestInit: { headers: { Authorization: `Bearer ${accessToken}` } },
    }));
    return client;
  };

  const tool = async <T>(client: Client, name: string, args: Record<string, unknown>): Promise<T> => {
    const result = (await client.callTool({ name, arguments: args })) as { isError?: boolean; content: { text: string }[] };
    if (result.isError) {
      throw new Error(result.content[0].text);
    }
    return JSON.parse(result.content[0].text) as T;
  };

  const liveToken = (session = sessionId) =>
    tool<{ token: string; command: string; pollUrl: string; expiresAt: string }>(alice, 'live_token', { session });

  const poll = (headers: Record<string, string>, session = sessionId, wait = 0) =>
    fetch(`${server.base}/live/await?session=${session}&wait=${wait}`, { headers });

  const page = async (path: string, init: { cookie?: string; json?: unknown; method?: string } = {}) => {
    const res = await fetch(`${server.base}/s/${sessionId}/api${path}`, {
      method: init.method ?? (init.json ? 'POST' : 'GET'),
      headers: {
        cookie: init.cookie ?? aliceCookie,
        'Sec-Fetch-Site': 'same-origin',
        ...(init.json ? { 'Content-Type': 'application/json' } : {}),
      },
      body: init.json ? JSON.stringify(init.json) : undefined,
    });
    return { status: res.status, body: await res.json() };
  };

  const askOnLine = async (body: string) => (await page('/threads', {
    json: { sessionId, filePath: 'src.ts', side: 'new', startLine: 10, endLine: 10, body, author: { name: 'You', type: 'user' }, ask: true },
  })).body as CommentThread;

  const run = (command: string) => new Promise<{ code: number; stdout: string; stderr: string }>(resolve => {
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/proxy/i.test(key)));
    execFile('sh', ['-c', command], { env, timeout: 20_000 }, (err, stdout, stderr) => {
      resolve({ code: err ? (typeof err.code === 'number' ? err.code : -1) : 0, stdout, stderr });
    });
  });

  beforeAll(async () => {
    fixture = makeFixture();
    github = await startFakeGitHub([
      { owner: 'acme', name: 'widgets', private: false, tokens: [], pulls: {} },
    ]);
    dataDir = tempDir('live');
    server = await startTestServer(dataDir, github.url, { remoteUrl: fixture.remoteUrl, uiDir: fakeUiDir(dataDir) });
    aliceCookie = await login(server.base, 'alice@example.com');
    bobCookie = await login(server.base, 'bob@example.com');
    aliceAccess = (await connectAgent(server.base, aliceCookie)).accessToken;
    alice = await mcpClient(aliceAccess);
    bob = await mcpClient((await connectAgent(server.base, bobCookie)).accessToken);
    sessionId = (await tool<{ session: string }>(alice, 'create_session', { repo: 'acme/widgets', base: fixture.base, head: fixture.head1 })).session;
    otherSessionId = (await tool<{ session: string }>(alice, 'create_session', { repo: 'acme/widgets', base: fixture.base, head: fixture.head2 })).session;
  });

  afterAll(async () => {
    await alice?.close();
    await bob?.close();
    await server.close();
    await github.close();
    removeDir(fixture.root);
    removeDir(dataDir);
  });

  it('gives a command and a poll URL for the session', async () => {
    const issued = await liveToken(sessionId.slice(0, 8));
    expect(issued.pollUrl).toBe(`${server.base}/live/await?session=${sessionId}&wait=25`);
    expect(issued.command).toContain(`'Authorization: Bearer ${issued.token}'`);
    expect(issued.command).toContain(`'${issued.pollUrl}'`);
    expect(Date.parse(issued.expiresAt) - Date.now()).toBeGreaterThan(LIVE_TOKEN_TTL_MS - 60_000);
  });

  it('refuses anything but a live token for this very session', async () => {
    const { token } = await liveToken();
    const expired = await server.live.issueToken((await server.users.findOrCreate('alice@example.com')).id, sessionId, Date.now() - LIVE_TOKEN_TTL_MS - 1);

    expect((await poll({})).status).toBe(401);
    expect((await poll({ cookie: aliceCookie })).status).toBe(401);
    expect((await poll({ Authorization: `Bearer ${aliceAccess}` })).status).toBe(401);
    expect((await poll({ Authorization: `Bearer ${token}` }, otherSessionId)).status).toBe(401);
    expect((await poll({ Authorization: `Bearer ${expired.token}` })).status).toBe(401);
    expect((await poll({ Authorization: `Bearer ${token}` })).status).toBe(204);
  });

  it('refuses a live token everywhere else', async () => {
    const { token } = await liveToken();
    const mcp = await fetch(`${server.base}/mcp`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });
    expect(mcp.status).toBe(401);
    const threads = await fetch(`${server.base}/s/${sessionId}/api/threads`, { headers: { Authorization: `Bearer ${token}` } });
    expect(threads.status).toBe(401);
  });

  it('shows the page whether an agent is listening', async () => {
    const bobs = await page('/live/status', { cookie: bobCookie });
    expect(bobs.status).toBe(404);
    const before = (await page('/live/status', { cookie: aliceCookie })).body;
    const { token } = await liveToken();
    await poll({ Authorization: `Bearer ${token}` });
    const after = (await page('/live/status')).body;
    expect(after.listening).toBe(true);
    expect(Date.now() - Date.parse(after.lastPollAt)).toBeLessThan(5000);
    expect(before.lastPollAt === null || Date.parse(before.lastPollAt) <= Date.parse(after.lastPollAt)).toBe(true);
  });

  it('wakes a held poll with the question, and the agent’s reply answers it', async () => {
    const { token } = await liveToken();
    const held = poll({ Authorization: `Bearer ${token}` }, sessionId, 10);
    await new Promise(resolve => setTimeout(resolve, 100));
    const thread = await askOnLine('Why line ten?');
    expect(thread.comments[0]).toMatchObject({ kind: 'aside', ask: 'pending' });

    const res = await held;
    expect(res.status).toBe(200);
    const request = await res.json();
    expect(request).toMatchObject({ session: sessionId, thread: thread.id, file: 'src.ts', line: 10, question: 'Why line ten?' });
    expect(request.hint).toContain(`reply { id: "${thread.id}"`);

    await tool(alice, 'reply', { id: thread.id, body: 'Because the feature needs it.', aside: true });
    const threads = (await page('/threads')).body as CommentThread[];
    const answered = threads.find(t => t.id === thread.id)!;
    expect(answered.comments.map(c => [c.body, c.ask])).toEqual([
      ['Why line ten?', 'answered'],
      ['Because the feature needs it.', undefined],
    ]);
    expect((await poll({ Authorization: `Bearer ${token}` })).status).toBe(204);
  });

  it('queues a reply asked on an existing thread', async () => {
    const finding = await tool<{ thread: string }>(alice, 'comment', { session: sessionId, file: 'src.ts', line: 10, body: 'P2: untested' });
    const reply = await page(`/threads/${finding.thread}/reply`, { json: { body: 'Is it?', author: { name: 'You', type: 'user' }, ask: true } });
    expect(reply.body).toMatchObject({ kind: 'aside', ask: 'pending' });

    const { token } = await liveToken();
    const res = await poll({ Authorization: `Bearer ${token}` });
    expect(await res.json()).toMatchObject({ thread: finding.thread, question: 'Is it?' });
    await tool(alice, 'reply', { id: finding.thread, body: 'Yes.' });
  });

  it('keeps one user’s questions from another user’s agent', async () => {
    await expect(tool(bob, 'live_token', { session: sessionId })).rejects.toThrow('No session matches');
    const asked = await page('/threads', {
      cookie: bobCookie,
      json: { sessionId, filePath: 'src.ts', side: 'new', startLine: 1, endLine: 1, body: 'x', author: { name: 'You', type: 'user' }, ask: true },
    });
    expect(asked.status).toBe(404);
  });

  it('runs as a command that exits with the question, or with 1 once the token is refused', async () => {
    const { command } = await liveToken();
    const waiting = run(command);
    await new Promise(resolve => setTimeout(resolve, 300));
    const thread = await askOnLine('From the shell?');
    const done = await waiting;
    expect(done.code).toBe(0);
    expect(JSON.parse(done.stdout)).toMatchObject({ thread: thread.id, question: 'From the shell?' });
    await tool(alice, 'reply', { id: thread.id, body: 'Yes.' });

    const refused = await run(command.replace(/Bearer [^']+/, 'Bearer nope'));
    expect(refused.code).toBe(1);
    expect(refused.stderr).toContain('live token was refused');
  });
});

describe('the attendant over HTTP', () => {
  let fixture: Fixture;
  let github: FakeGitHub;
  let dataDir: string;
  let server: TestServer;
  let aliceCookie: string;
  let bobCookie: string;
  let alice: Client;
  let bob: Client;
  let aliceId: string;

  const mcpClient = async (accessToken: string): Promise<Client> => {
    const client = new Client({ name: 'test', version: '1.0.0' });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${server.base}/mcp`), {
      requestInit: { headers: { Authorization: `Bearer ${accessToken}` } },
    }));
    return client;
  };

  const tool = async <T>(client: Client, name: string, args: Record<string, unknown>): Promise<T> => {
    const result = (await client.callTool({ name, arguments: args })) as { isError?: boolean; content: { text: string }[] };
    if (result.isError) {
      throw new Error(result.content[0].text);
    }
    const text = result.content[0].text;
    return (text.startsWith('{') || text.startsWith('[') ? JSON.parse(text) : text) as T;
  };

  const userToken = async (client = alice) =>
    tool<{ token: string; command: string; pollUrl: string; session: string | null }>(client, 'live_token', {});

  const poll = (token: string, session?: string, wait = 0) =>
    fetch(`${server.base}/live/await?${session ? `session=${session}&` : ''}wait=${wait}`, { headers: { Authorization: `Bearer ${token}` } });

  const createAndReview = (cookie: string, pr: number) => fetch(`${server.base}/sessions`, {
    method: 'POST',
    redirect: 'manual',
    headers: { cookie, 'Content-Type': 'application/x-www-form-urlencoded', 'Sec-Fetch-Site': 'same-origin' },
    body: new URLSearchParams({ repo: 'acme/widgets', pr: String(pr), review: '1' }).toString(),
  });

  const sessionFrom = (res: Response) => /^\/s\/([^/]+)\/$/.exec(res.headers.get('location') ?? '')![1];

  const info = async (session: string): Promise<RepoInfoResponse> =>
    (await fetch(`${server.base}/s/${session}/api/info`, { headers: { cookie: aliceCookie } })).json() as Promise<RepoInfoResponse>;

  const reviewRequests = (session: string) =>
    server.db.query<{ answered_at: number | null; created_at: string }>(
      "SELECT answered_at, created_at FROM live_requests WHERE session_id = $1 AND kind = 'review' ORDER BY seq",
      [session],
    );

  const run = (command: string) => new Promise<{ code: number; stdout: string }>(resolve => {
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/proxy/i.test(key)));
    execFile('sh', ['-c', command], { env, timeout: 20_000 }, (err, stdout) => {
      resolve({ code: err ? (typeof err.code === 'number' ? err.code : -1) : 0, stdout });
    });
  });

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
    dataDir = tempDir('attendant');
    server = await startTestServer(dataDir, github.url, { remoteUrl: fixture.remoteUrl, uiDir: fakeUiDir(dataDir) });
    aliceCookie = await login(server.base, 'alice@example.com');
    bobCookie = await login(server.base, 'bob@example.com');
    aliceId = (await server.users.findOrCreate('alice@example.com')).id;
    alice = await mcpClient((await connectAgent(server.base, aliceCookie)).accessToken);
    bob = await mcpClient((await connectAgent(server.base, bobCookie)).accessToken);
  });

  afterAll(async () => {
    await alice?.close();
    await bob?.close();
    await server.close();
    await github.close();
    removeDir(fixture.root);
    removeDir(dataDir);
  });

  it('issues a token for the user’s queue, polled without a session', async () => {
    const issued = await userToken();
    expect(issued.session).toBeNull();
    expect(issued.pollUrl).toBe(`${server.base}/live/await?wait=25`);
    expect(issued.command).toContain(`'${issued.pollUrl}'`);
    expect((await poll(issued.token)).status).toBe(204);

    const bobs = (await tool<{ session: string }>(bob, 'create_session', { repo: 'acme/widgets', base: fixture.base, head: fixture.head2 })).session;
    expect((await poll(issued.token, bobs)).status).toBe(401);
    const mine = (await tool<{ session: string }>(alice, 'create_session', { repo: 'acme/widgets', base: fixture.base, head: fixture.head2 })).session;
    expect((await poll(issued.token, mine)).status).toBe(204);

    const scoped = await tool<{ token: string }>(alice, 'live_token', { session: mine });
    const refused = await poll(scoped.token);
    expect(refused.status).toBe(401);
    expect((await refused.json()).error).toContain('live_token {}');
  });

  it('says on the Sessions page and its status whether an agent waits on the queue', async () => {
    github.reviewRequests['alice-token'] = [
      { owner: 'acme', repo: 'widgets', number: 7, title: 'Something new', author: 'carol', updatedAt: '2026-10-03T09:15:00Z' },
    ];
    await server.users.setGitHubToken(aliceId, 'alice-token');
    await server.db.query('UPDATE users SET live_polled_at = NULL');
    try {
      const status = () => fetch(`${server.base}/api/live/status`, { headers: { cookie: aliceCookie } }).then(res => res.json());
      expect((await fetch(`${server.base}/api/live/status`)).status).toBe(401);
      expect(await status()).toEqual({ listening: false, lastPollAt: null });
      const before = await (await fetch(`${server.base}/`, { headers: { cookie: aliceCookie } })).text();
      expect(before).not.toContain('Agent listening');
      expect(before).toContain('<button type="submit">Create session</button>');

      await poll((await userToken()).token);
      expect((await status()).listening).toBe(true);
      const after = await (await fetch(`${server.base}/`, { headers: { cookie: aliceCookie } })).text();
      expect(after).toContain('<strong>Agent listening</strong>');
      expect(after).toContain('<input type="hidden" name="review" value="1"><button type="submit">Create and review</button>');
      expect((await fetch(`${server.base}/api/live/status`, { headers: { cookie: bobCookie } }).then(res => res.json())).listening).toBe(false);
    } finally {
      await server.users.setGitHubToken(aliceId, null);
    }
  });

  it('hands a session created with review=1 to the waiting agent, and the page follows it to done', async () => {
    const { token, command } = await userToken();
    const waiting = run(command);
    await new Promise(resolve => setTimeout(resolve, 300));

    const created = await createAndReview(aliceCookie, 1);
    expect(created.status).toBe(303);
    const session = sessionFrom(created);
    const delivered = await waiting;
    expect(delivered.code).toBe(0);
    const request = JSON.parse(delivered.stdout);
    expect(request).toMatchObject({ session, kind: 'review', repo: 'acme/widgets', pr: 1, url: `${server.base}/s/${session}/` });
    expect(request.hint).toContain('review_start');
    expect((await info(session)).review).toMatchObject({ state: 'queued', startedAt: null });

    expect(sessionFrom(await createAndReview(aliceCookie, 1))).toBe(session);
    expect(await reviewRequests(session)).toHaveLength(1);
    expect((await poll(token)).status).toBe(204);

    await tool(alice, 'review_start', { session });
    expect((await info(session)).review?.state).toBe('reviewing');
    await tool(alice, 'comment', { session, file: 'src.ts', line: 10, body: 'P2: untested' });
    await tool(alice, 'review_done', { session });
    const done = (await info(session)).review!;
    expect(done.state).toBe('done');
    expect(done.doneAt).not.toBeNull();
    expect((await reviewRequests(session))[0].answered_at).not.toBeNull();
  });

  it('queues from create_session { review: true } once, keeps it from other users, and lets it go stale unclaimed', async () => {
    const first = await tool<{ session: string; review: string }>(alice, 'create_session', { repo: 'acme/widgets', base: fixture.base, head: fixture.head1, review: true });
    expect(first.review).toBe('queued');
    const again = await tool<{ review: string }>(alice, 'create_session', { repo: 'acme/widgets', base: fixture.base, head: fixture.head1, review: true });
    expect(again.review).toBe('already queued');
    expect((await reviewRequests(first.session)).filter(request => request.answered_at === null)).toHaveLength(1);

    expect((await poll((await userToken(bob)).token)).status).toBe(204);
    expect((await info(first.session)).review?.state).toBe('queued');
    await server.db.query("UPDATE live_requests SET created_at = $1 WHERE session_id = $2 AND kind = 'review'", [
      new Date(Date.now() - REVIEW_STALE_MS - 1000).toISOString(),
      first.session,
    ]);
    expect((await info(first.session)).review?.state).toBe('stale');

    const res = await poll((await userToken()).token);
    expect(await res.json()).toMatchObject({ kind: 'review', session: first.session });
    expect((await info(first.session)).review?.state).toBe('queued');
    await tool(alice, 'review_start', { session: first.session });
    await tool(alice, 'review_done', { session: first.session });
  });

  it('brings questions from any session to the queue’s agent, and counts it as listening there', async () => {
    const session = (await tool<{ session: string }>(alice, 'create_session', { repo: 'acme/widgets', base: fixture.base, head: fixture.head2 })).session;
    const { token } = await userToken();
    const held = poll(token, undefined, 10);
    await new Promise(resolve => setTimeout(resolve, 100));
    const thread = (await (await fetch(`${server.base}/s/${session}/api/threads`, {
      method: 'POST',
      headers: { cookie: aliceCookie, 'Sec-Fetch-Site': 'same-origin', 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: session, filePath: 'src.ts', side: 'new', startLine: 10, endLine: 10, body: 'Why?', author: { name: 'You', type: 'user' }, ask: true }),
    })).json()) as CommentThread;
    expect(await (await held).json()).toMatchObject({ kind: 'ask', session, thread: thread.id, question: 'Why?' });
    await tool(alice, 'reply', { id: thread.id, body: 'Because.', aside: true });

    const status = await (await fetch(`${server.base}/s/${session}/api/live/status`, { headers: { cookie: aliceCookie } })).json();
    expect(status.listening).toBe(true);
  });
});
