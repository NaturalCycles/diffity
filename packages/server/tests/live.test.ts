import { execFile } from 'node:child_process';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { CommentThread } from '@diffity/api';
import { CLAIM_TTL_MS, LIVE_TOKEN_TTL_MS, Live } from '../src/live.js';
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
    expect(await live.next(alice, sessionId, 200, new AbortController().signal)).toBeNull();
    expect(Date.now() - started).toBeGreaterThanOrEqual(190);

    const waiting = live.next(alice, sessionId, 10_000, new AbortController().signal);
    await new Promise(resolve => setTimeout(resolve, 50));
    const thread = await question();
    const woken = Date.now();
    expect((await waiting)?.threadId).toBe(thread.id);
    expect(Date.now() - woken).toBeLessThan(2000);
    await live.answer(alice, thread.id);
  });

  it('stops waiting when the poller leaves', async () => {
    const gone = new AbortController();
    const waiting = live.next(alice, sessionId, 10_000, gone.signal);
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
