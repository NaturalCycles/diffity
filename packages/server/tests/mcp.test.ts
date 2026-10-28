import { generateKeyPairSync } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {
  connectAgent,
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
let alice: Client;
let bob: Client;
let pulls: Record<number, { title: string; baseSha: string; headSha: string }>;

async function mcpClient(accessToken: string, base = server.base): Promise<Client> {
  const transport = new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
    requestInit: { headers: { Authorization: `Bearer ${accessToken}` } },
  });
  const client = new Client({ name: 'test', version: '1.0.0' });
  await client.connect(transport);
  return client;
}

interface ToolResult {
  isError?: boolean;
  content: { type: string; text: string }[];
}

async function call(client: Client, name: string, args: Record<string, unknown>): Promise<ToolResult> {
  return (await client.callTool({ name, arguments: args })) as ToolResult;
}

async function ok<T = Record<string, unknown>>(client: Client, name: string, args: Record<string, unknown>): Promise<T> {
  const result = await call(client, name, args);
  if (result.isError) {
    throw new Error(`${name} failed: ${result.content[0]?.text}`);
  }
  const textContent = result.content[0]?.text ?? '';
  try {
    return JSON.parse(textContent) as T;
  } catch {
    return textContent as T;
  }
}

async function failed(client: Client, name: string, args: Record<string, unknown>): Promise<string> {
  const result = await call(client, name, args);
  expect(result.isError).toBe(true);
  return result.content[0].text;
}

async function mcpStatus(token: string, base = server.base): Promise<number> {
  const res = await fetch(`${base}/mcp`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
  });
  return res.status;
}

beforeAll(async () => {
  fixture = makeFixture();
  pulls = { 1: { title: 'Change line ten', baseSha: fixture.mainTip, headSha: fixture.head1 } };
  github = await startFakeGitHub([
    { owner: 'acme', name: 'widgets', private: true, tokens: ['alice-token', 'bob-token'], pulls },
  ]);
  dataDir = tempDir('mcp');
  server = await startTestServer(dataDir, github.url, { remoteUrl: fixture.remoteUrl, uiDir: fakeUiDir(dataDir) });
  const aliceCookie = await login(server.base, 'alice@example.com');
  const bobCookie = await login(server.base, 'bob@example.com');
  await server.users.setGitHubToken((await server.users.findOrCreate('alice@example.com')).id, 'alice-token');
  await server.users.setGitHubToken((await server.users.findOrCreate('bob@example.com')).id, 'bob-token');
  alice = await mcpClient((await connectAgent(server.base, aliceCookie, 'Test Agent')).accessToken);
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

describe('authentication', () => {
  it('answers an unauthenticated request with 401 and where to find the authorization server', async () => {
    const res = await fetch(`${server.base}/mcp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });
    expect(res.status).toBe(401);
    expect(res.headers.get('www-authenticate')).toContain(
      `resource_metadata="${server.base}/.well-known/oauth-protected-resource/mcp"`,
    );
  });

  it('refuses a made-up token', async () => {
    const res = await fetch(`${server.base}/mcp`, {
      method: 'POST',
      headers: { Authorization: 'Bearer nope', 'Content-Type': 'application/json' },
      body: '{}',
    });
    expect(res.status).toBe(401);
  });

  it('is stateless, so only POST is served', async () => {
    const res = await fetch(`${server.base}/mcp`, { headers: { Authorization: 'Bearer nope' } });
    expect(res.status).toBe(401);
  });
});

describe('a review through the tools', () => {
  it('lists every tool', async () => {
    const { tools } = await alice.listTools();
    expect(tools.map(tool => tool.name).sort()).toEqual([
      'amend', 'automation_token', 'automation_token_revoke', 'automation_tokens', 'comment', 'create_session', 'dismiss',
      'general_comment', 'get_diff', 'get_file', 'get_standards', 'list_comments', 'list_review_requests', 'list_sessions',
      'live_token', 'post_review', 'reply', 'resolve', 'review_done', 'review_start', 'tour_delete', 'tour_done', 'tour_start',
      'tour_step',
    ]);
  });

  it('runs create_session → comment → list_comments → tour → review_done on two commits', async () => {
    const created = await ok<{ session: string; url: string; files: { path: string }[]; base: string; head: string }>(
      alice, 'create_session', { repo: 'acme/widgets', base: fixture.base, head: fixture.head1 },
    );
    expect(created.url).toBe(`${server.base}/s/${created.session}/`);
    expect(created.files.map(f => f.path).sort()).toEqual(['added.ts', 'src.ts']);
    const session = created.session.slice(0, 8);

    await ok(alice, 'review_start', { session, note: 'first pass' });
    expect(await ok<string>(alice, 'get_diff', { session, file: 'added.ts' })).toContain('+export const added = 1;');
    expect(await ok<string>(alice, 'get_file', { session, path: 'added.ts' })).toBe('export const added = 1;\n');
    expect(await failed(alice, 'get_file', { session, path: 'added.ts', side: 'old' })).toContain('does not exist on the old side');
    expect(await ok(alice, 'get_standards', { session })).toMatchObject({ severities: ['blocker', 'nit'] });

    const finding = await ok<{ thread: string }>(alice, 'comment', {
      session, file: 'src.ts', line: 10, body: 'P1: why change line ten?',
    });
    const clamped = await ok<{ thread: string; startLine: number; warning?: string }>(alice, 'comment', {
      session, file: 'added.ts', line: 5, endLine: 9, body: 'Past the end',
    });
    expect(clamped).toMatchObject({ startLine: 1 });
    expect(clamped.warning).toContain('fewer lines');
    expect(await failed(alice, 'comment', { session, file: 'README.md', line: 1, body: 'x' })).toContain('not on the new side');
    expect(await failed(alice, 'comment', { session, file: 'src.ts', line: 5, endLine: 4, body: 'x' })).toContain('endLine');
    await ok(alice, 'general_comment', { session, body: 'One finding.' });

    await ok(alice, 'reply', { id: finding.thread.slice(0, 8), body: 'An aside', aside: true, session });
    await ok(alice, 'amend', { id: finding.thread, body: 'P1: line ten changed without a test' });
    await ok(alice, 'dismiss', { id: clamped.thread, reason: 'noise' });

    const threads = await ok<{ id: string; file: string | null; startLine: number; comments: { body: string; author: { name: string; type: string } }[] }[]>(
      alice, 'list_comments', { session, status: 'open' },
    );
    const onTen = threads.find(t => t.id === finding.thread)!;
    expect(onTen.comments.map(c => c.body)).toEqual(['P1: line ten changed without a test', 'An aside']);
    expect(onTen.comments[0].author).toEqual({ name: 'Test Agent', type: 'agent' });
    expect(threads.some(t => t.file === null)).toBe(true);
    expect(threads.some(t => t.id === clamped.thread)).toBe(false);

    const tour = await ok<{ tour: string }>(alice, 'tour_start', { session, topic: 'Reading order' });
    await ok(alice, 'tour_step', { tour: tour.tour, file: 'src.ts', line: 10, body: 'The change', annotation: 'the change' });
    expect(await failed(alice, 'tour_step', { tour: tour.tour, file: 'missing.ts', line: 1, body: 'x' })).toContain('does not exist');
    await ok(alice, 'tour_done', { tour: tour.tour });
    await ok(alice, 'review_done', { session });

    const listed = await ok<{ session: string }[]>(alice, 'list_sessions', { repo: 'acme/widgets' });
    expect(listed.map(s => s.session)).toContain(created.session);

    await ok(alice, 'resolve', { id: finding.thread, summary: 'Added a test' });
    expect(await ok<unknown[]>(alice, 'list_comments', { session, status: 'resolved' })).toHaveLength(1);
  });

  it('reviews a patch that was never pushed', async () => {
    const patch = git(fixture.work, ['diff', fixture.base, fixture.head2]) + '\n';
    const created = await ok<{ session: string; kind: string; files: { path: string }[] }>(
      alice, 'create_session', { repo: 'acme/widgets', base: fixture.base, patch },
    );
    expect(created.kind).toBe('patch');
    expect(created.files.map(f => f.path)).toContain('new-name.ts');
    const finding = await ok<{ thread: string }>(alice, 'comment', { session: created.session, file: 'src.ts', line: 13, body: 'x' });
    expect(finding.thread).toBeTruthy();
    expect(await failed(alice, 'create_session', { repo: 'acme/widgets', base: fixture.base, patch: 'not a patch\n' })).toMatch(/patch/i);
  });

  it('reviews a pull request', async () => {
    const created = await ok<{ pr: number; base: string; head: string; title: string }>(alice, 'create_session', { repo: 'acme/widgets', pr: 1 });
    expect(created).toMatchObject({ pr: 1, base: fixture.base, head: fixture.head1, title: 'Change line ten' });
  });

  it('lists the pull requests waiting for the user’s review, with the session on each', async () => {
    github.reviewRequests['alice-token'] = [
      { owner: 'acme', repo: 'widgets', number: 1, title: 'Change line ten', author: 'octocat', updatedAt: '2026-10-03T09:00:00Z' },
      { owner: 'acme', repo: 'widgets', number: 5, title: 'WIP', author: 'octocat', draft: true, updatedAt: '2026-10-02T09:00:00Z' },
    ];
    const created = await ok<{ session: string }>(alice, 'create_session', { repo: 'acme/widgets', pr: 1 });
    expect(await ok(alice, 'list_review_requests', {})).toEqual({
      requests: [{
        repo: 'acme/widgets',
        pr: 1,
        title: 'Change line ten',
        author: 'octocat',
        draft: false,
        updatedAt: '2026-10-03T09:00:00Z',
        url: 'https://github.com/acme/widgets/pull/1',
        session: expect.objectContaining({ id: created.session, headSha: fixture.head1, url: `${server.base}/s/${created.session}/` }),
      }],
      hidden: 1,
    });
    expect(await ok(bob, 'list_review_requests', {})).toEqual({ requests: [], hidden: 0 });
  });

  it('turns every mistake into a readable error result', async () => {
    expect(await failed(alice, 'create_session', { repo: 'acme/widgets' })).toContain('exactly one of');
    expect(await failed(alice, 'create_session', { repo: 'acme/nothing', pr: 1 })).toContain('cannot read it');
    expect(await failed(alice, 'get_diff', { session: 'deadbeef' })).toContain('No session matches');
    expect(await failed(alice, 'reply', { id: 'deadbeef', body: 'x' })).toContain('No thread matches');
    expect(await failed(alice, 'amend', { id: 'deadbeef', body: 'x' })).toContain('No comment or thread');
    expect(await failed(alice, 'tour_done', { tour: 'deadbeef' })).toContain('No walkthrough');
  });
});

describe('the review prompt', () => {
  it('holds the review method, aimed at the pull request asked for', async () => {
    const { prompts } = await alice.listPrompts();
    expect(prompts.map(prompt => [prompt.name, prompt.arguments?.map(arg => [arg.name, arg.required ?? false])])).toEqual([
      ['review', [['repo', true], ['pr', false]]],
    ]);
    const withPr = await alice.getPrompt({ name: 'review', arguments: { repo: 'acme/widgets', pr: '#7' } });
    const text = (withPr.messages[0].content as { text: string }).text;
    expect(text).toMatch(/^Review pull request #7 of acme\/widgets: `create_session \{ repo: "acme\/widgets", pr: 7 \}`\./);
    expect(text).toContain('review_start');
    expect(text).toContain('### Step 6: Hand over the review');
    expect(text).toContain('post_review');
    expect(text).not.toContain('user-invocable');
    const repoOnly = await alice.getPrompt({ name: 'review', arguments: { repo: 'acme/widgets' } });
    expect((repoOnly.messages[0].content as { text: string }).text).toMatch(/^Review a change in acme\/widgets\./);
  });

  it('is named in create_session\'s description', async () => {
    const { tools } = await alice.listTools();
    expect(tools.find(tool => tool.name === 'create_session')?.description).toContain('`review` prompt');
  });
});

describe('isolation', () => {
  it('gives another user nothing of this user’s sessions, threads or tours', async () => {
    const created = await ok<{ session: string }>(alice, 'create_session', { repo: 'acme/widgets', base: fixture.base, head: fixture.head2 });
    const finding = await ok<{ thread: string }>(alice, 'comment', { session: created.session, file: 'added.ts', line: 1, body: 'Mine' });
    const tour = await ok<{ tour: string }>(alice, 'tour_start', { session: created.session, topic: 'Mine' });

    const bobs = await ok<{ session: string }[]>(bob, 'list_sessions', {});
    expect(bobs.map(s => s.session)).not.toContain(created.session);
    expect(await failed(bob, 'get_diff', { session: created.session })).toContain('No session matches');
    expect(await failed(bob, 'list_comments', { session: created.session })).toContain('No session matches');
    expect(await failed(bob, 'comment', { session: created.session, file: 'added.ts', line: 1, body: 'x' })).toContain('No session matches');
    expect(await failed(bob, 'reply', { id: finding.thread, body: 'hijack' })).toContain('No thread matches');
    expect(await failed(bob, 'resolve', { id: finding.thread })).toContain('No thread matches');
    expect(await failed(bob, 'amend', { id: finding.thread, body: 'hijack' })).toContain('No comment or thread');
    expect(await failed(bob, 'tour_step', { tour: tour.tour, file: 'added.ts', line: 1, body: 'x' })).toContain('No walkthrough');
    expect(await failed(bob, 'tour_delete', { tour: tour.tour })).toContain('No walkthrough');

    const mine = await ok<{ id: string; comments: { body: string }[] }[]>(alice, 'list_comments', { session: created.session });
    expect(mine).toHaveLength(1);
    expect(mine[0].comments.map(c => c.body)).toEqual(['Mine']);
    expect(await failed(alice, 'reply', { id: finding.thread, body: 'x', session: (await ok<{ session: string }>(alice, 'create_session', { repo: 'acme/widgets', pr: 1 })).session })).toContain('another session');
    await ok(alice, 'tour_delete', { tour: tour.tour });
  });
});

describe('automation tokens', () => {
  it('mint one shown once, list them without it, and keep names unique per user', async () => {
    const minted = await ok<{ name: string; token: string; use: string }>(alice, 'automation_token', { name: 'pr routine' });
    expect(minted.token).toMatch(/^dfa_[A-Za-z0-9_-]{43}$/);
    expect(minted.use).toContain(`${server.base}/mcp`);
    expect(await failed(alice, 'automation_token', { name: 'pr routine' })).toContain('already have an automation token named "pr routine"');
    await ok(bob, 'automation_token', { name: 'pr routine' });

    const listed = await ok<{ name: string; createdAt: string; lastUsedAt: string | null }[]>(alice, 'automation_tokens', {});
    expect(listed).toEqual([{ name: 'pr routine', createdAt: expect.any(String), lastUsedAt: null }]);
    expect(JSON.stringify(listed)).not.toContain(minted.token);
    expect(JSON.stringify(await server.db.query('SELECT * FROM automation_tokens'))).not.toContain(minted.token);
    await ok(alice, 'automation_token_revoke', { name: 'pr routine' });
    await ok(bob, 'automation_token_revoke', { name: 'pr routine' });
  });

  it('reach /mcp as the user who minted them, until revoked', async () => {
    const { token } = await ok<{ token: string }>(alice, 'automation_token', { name: 'routine' });
    const routine = await mcpClient(token);
    try {
      const created = await ok<{ session: string }>(routine, 'create_session', { repo: 'acme/widgets', base: fixture.base, head: fixture.head1 });
      expect((await ok<{ session: string }[]>(alice, 'list_sessions', {})).map(s => s.session)).toContain(created.session);
      expect((await ok<{ session: string }[]>(bob, 'list_sessions', {})).map(s => s.session)).not.toContain(created.session);
      const finding = await ok<{ thread: string }>(routine, 'comment', { session: created.session, file: 'added.ts', line: 1, body: 'From the routine' });
      const [thread] = (await ok<{ id: string; comments: { author: { name: string; type: string } }[] }[]>(alice, 'list_comments', { session: created.session }))
        .filter(t => t.id === finding.thread);
      expect(thread.comments[0].author).toEqual({ name: 'routine', type: 'agent' });
      expect((await ok<{ lastUsedAt: string | null }[]>(alice, 'automation_tokens', {}))[0].lastUsedAt).not.toBeNull();

      await ok(alice, 'automation_token_revoke', { name: 'routine' });
      expect(await mcpStatus(token)).toBe(401);
      expect(await failed(alice, 'automation_token_revoke', { name: 'routine' })).toContain('no automation token named');
    } finally {
      await routine.close();
    }
  });

  it('cannot mint, list or revoke automation tokens themselves', async () => {
    const { token } = await ok<{ token: string }>(alice, 'automation_token', { name: 'locked out' });
    const routine = await mcpClient(token);
    try {
      for (const [name, args] of [
        ['automation_token', { name: 'another' }],
        ['automation_tokens', {}],
        ['automation_token_revoke', { name: 'locked out' }],
      ] as const) {
        expect(await failed(routine, name, args)).toBe('Automation tokens are managed by a signed-in agent, not by an automation token');
      }
      expect((await ok<{ name: string }[]>(alice, 'automation_tokens', {})).map(t => t.name)).toEqual(['locked out']);
      await ok(alice, 'automation_token_revoke', { name: 'locked out' });
    } finally {
      await routine.close();
    }
  });

  it('refuses a made-up one, and leaves OAuth tokens to OAuth', async () => {
    expect(await mcpStatus(`dfa_${'x'.repeat(43)}`)).toBe(401);
    expect(await mcpStatus('dfa_')).toBe(401);
    expect((await alice.listTools()).tools.length).toBeGreaterThan(0);
  });
});

describe('session tokens', () => {
  it('work on their one session through the review tools, and on nothing else', async () => {
    const aliceId = (await server.users.findOrCreate('alice@example.com')).id;
    const { session } = await ok<{ session: string }>(alice, 'create_session', { repo: 'acme/widgets', base: fixture.base, head: fixture.head1 });
    const other = await ok<{ session: string }>(alice, 'create_session', { repo: 'acme/widgets', base: fixture.base, head: fixture.head2 });
    const otherThread = await ok<{ thread: string }>(alice, 'comment', { session: other.session, file: 'added.ts', line: 1, body: 'Elsewhere' });
    const otherTour = await ok<{ tour: string }>(alice, 'tour_start', { session: other.session, topic: 'Elsewhere' });
    const { token } = await server.live.issueSessionToken(aliceId, session);
    const attendant = await mcpClient(token);
    try {
      const names = (await attendant.listTools()).tools.map(tool => tool.name);
      for (const removed of [
        'create_session', 'list_sessions', 'list_review_requests', 'get_diff', 'get_file',
        'automation_token', 'automation_tokens', 'automation_token_revoke',
      ]) {
        expect(names).not.toContain(removed);
      }
      expect(names).toEqual(expect.arrayContaining(['comment', 'list_comments', 'review_start', 'review_done', 'post_review', 'live_token']));

      await ok(attendant, 'review_start', { session: session.slice(0, 8) });
      const finding = await ok<{ thread: string }>(attendant, 'comment', { session, file: 'src.ts', line: 10, body: 'From the attendant' });
      const threads = await ok<{ id: string; comments: { author: { name: string; type: string } }[] }[]>(attendant, 'list_comments', { session });
      expect(threads.find(t => t.id === finding.thread)?.comments[0].author).toEqual({ name: 'Attendant', type: 'agent' });
      await ok(attendant, 'review_done', { session });
      expect(await failed(attendant, 'post_review', { session, event: 'COMMENT' })).toContain('not configured on this server');

      const only = `This token is for session ${session.slice(0, 8)} only`;
      expect(await failed(attendant, 'comment', { session: other.session, file: 'added.ts', line: 1, body: 'x' })).toBe(only);
      expect(await failed(attendant, 'list_comments', { session: other.session })).toBe(only);
      expect(await failed(attendant, 'review_start', { session: other.session })).toBe(only);
      expect(await failed(attendant, 'review_done', { session: other.session })).toBe(only);
      expect(await failed(attendant, 'post_review', { session: other.session, event: 'COMMENT' })).toBe(only);
      expect(await failed(attendant, 'reply', { id: otherThread.thread, body: 'x' })).toContain('belongs to another session');
      expect(await failed(attendant, 'resolve', { id: otherThread.thread })).toContain('belongs to another session');
      expect(await failed(attendant, 'amend', { id: otherThread.thread, body: 'x' })).toContain('belongs to another session');
      expect(await failed(attendant, 'tour_done', { tour: otherTour.tour })).toBe(only);

      const waiting = await ok<{ session: string; command: string; pollUrl: string; token: string }>(attendant, 'live_token', { session: other.session });
      expect(waiting.session).toBe(session);
      expect(waiting.pollUrl).toBe(`${server.base}/live/await?session=${session}&wait=25`);
      expect(waiting.command).toContain(waiting.pollUrl);
    } finally {
      await attendant.close();
      await ok(alice, 'tour_delete', { tour: otherTour.tour });
    }
  });

  it('wait on their session at /live/await', async () => {
    const aliceId = (await server.users.findOrCreate('alice@example.com')).id;
    const { session } = await ok<{ session: string }>(alice, 'create_session', { repo: 'acme/widgets', base: fixture.base, head: fixture.head1 });
    const { token } = await server.live.issueSessionToken(aliceId, session);
    const thread = await server.service.reviews.createThread({
      userId: aliceId, sessionId: session, filePath: 'src.ts', side: 'new', startLine: 10, endLine: 10, body: 'Why?', author: { name: 'Alice', type: 'user' },
    });
    await server.live.ask(aliceId, session, thread.id, thread.comments[0].id);
    const res = await fetch(`${server.base}/live/await?session=${session}&wait=0`, { headers: { Authorization: `Bearer ${token}` } });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ kind: 'ask', session, thread: thread.id, question: 'Why?' });
    await server.live.answer(aliceId, thread.id);
  });
});

describe('post_review', () => {
  it('answers that bot posting is not configured on a server without the App key', async () => {
    const { session } = await ok<{ session: string }>(alice, 'create_session', { repo: 'acme/widgets', pr: 1 });
    expect(await failed(alice, 'post_review', { session, event: 'COMMENT' })).toContain('not configured on this server');
  });

  it('takes no approval', async () => {
    const { session } = await ok<{ session: string }>(alice, 'create_session', { repo: 'acme/widgets', pr: 1 });
    expect(await failed(alice, 'post_review', { session, event: 'APPROVE' })).toContain('Input validation error');
    const tool = (await alice.listTools()).tools.find(t => t.name === 'post_review')!;
    expect((tool.inputSchema.properties as Record<string, { enum?: string[] }>).event.enum).toEqual(['COMMENT', 'REQUEST_CHANGES']);
  });

  describe('on a server with the App key', () => {
    let botDir: string;
    let botServer: TestServer;
    let routine: Client;

    beforeAll(async () => {
      const pem = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs1', format: 'pem' }).toString();
      github.installations['acme/widgets'] = 7;
      botDir = tempDir('mcp-bot');
      botServer = await startTestServer(
        botDir,
        github.url,
        { remoteUrl: fixture.remoteUrl, uiDir: fakeUiDir(botDir), gitHubAccess: { tokenFor: async () => 'alice-token' } },
        { githubApp: { clientId: 'Iv1.client', clientSecret: 'secret', slug: 'diffity', bot: { appId: 1, privateKey: pem } } },
      );
      const cookie = await login(botServer.base, 'alice@example.com');
      await botServer.users.setGitHubToken((await botServer.users.findOrCreate('alice@example.com')).id, 'alice-token', 'alice-gh');
      const interactive = await mcpClient((await connectAgent(botServer.base, cookie)).accessToken, botServer.base);
      const { token } = await ok<{ token: string }>(interactive, 'automation_token', { name: 'pr routine' });
      await interactive.close();
      routine = await mcpClient(token, botServer.base);
    });

    afterAll(async () => {
      await routine?.close();
      await botServer?.close();
      removeDir(botDir);
    });

    it('posts the open findings as the App, with the summary and who asked, and only what is new the second time', async () => {
      const { session } = await ok<{ session: string }>(routine, 'create_session', { repo: 'acme/widgets', pr: 1 });
      await ok(routine, 'comment', { session, file: 'src.ts', line: 10, body: 'P2: line ten changed without a test' });
      await ok(routine, 'general_comment', { session, body: 'One finding.' });

      const before = github.postedReviews.length;
      const posted = await ok<{ posted: number; skipped: number; url: string }>(routine, 'post_review', { session, event: 'COMMENT' });
      expect(posted).toEqual({ posted: 1, skipped: 0, url: expect.stringContaining('#pullrequestreview-') });
      expect(github.postedReviews.length).toBe(before + 1);
      expect(github.postedReviews.at(-1)).toEqual({
        commit_id: fixture.head1,
        event: 'COMMENT',
        body: 'One finding.\n\n— diffity review, requested by @alice-gh',
        comments: [{ path: 'src.ts', side: 'RIGHT', line: 10, body: 'P2: line ten changed without a test' }],
      });
      expect(github.reviewTokens.at(-1)).toMatch(/^ghs_/);

      expect(await ok(routine, 'post_review', { session, event: 'COMMENT' })).toEqual({ posted: 0, skipped: 1, url: null });
      expect(await ok(routine, 'post_review', { session, event: 'REQUEST_CHANGES' })).toEqual({ posted: 0, skipped: 1, url: null });
      expect(github.postedReviews.length).toBe(before + 1);
    });

    it('skips a finding the App already left in the same words on the same line', async () => {
      const { session } = await ok<{ session: string }>(routine, 'create_session', { repo: 'acme/widgets', pr: 1 });
      const finding = { session, file: 'src.ts', line: 10, body: 'P3: say why line ten changed' };
      await ok(routine, 'comment', finding);
      expect(await ok<{ posted: number }>(routine, 'post_review', { session, event: 'COMMENT' })).toMatchObject({ posted: 1 });
      expect(github.comments.at(-1)?.user).toEqual({ login: 'diffity[bot]', type: 'Bot' });

      const before = github.postedReviews.length;
      const again = await ok<{ thread: string }>(routine, 'comment', finding);
      const result = await ok<{ posted: number; skipped: number; url: string | null }>(routine, 'post_review', { session, event: 'COMMENT' });
      expect(result).toMatchObject({ posted: 0, url: null });
      expect(result.skipped).toBeGreaterThanOrEqual(2);
      expect(github.postedReviews.length).toBe(before);
      await ok(routine, 'dismiss', { id: again.thread });
    });

    it('posts the summary once when two runs post at the same time', async () => {
      const { session } = await ok<{ session: string }>(routine, 'create_session', { repo: 'acme/widgets', pr: 1 });
      await ok(routine, 'comment', { session, file: 'src.ts', line: 9, body: 'P3: line nine deserves a look' });
      await ok(routine, 'general_comment', { session, body: 'Posted once.' });

      const before = github.postedReviews.length;
      const results = await Promise.all([
        ok<{ url: string | null }>(routine, 'post_review', { session, event: 'COMMENT' }),
        ok<{ url: string | null }>(routine, 'post_review', { session, event: 'COMMENT' }),
      ]);
      expect(github.postedReviews.length).toBe(before + 1);
      expect(github.postedReviews.at(-1)?.body).toContain('Posted once.');
      expect(results.filter(result => result.url !== null)).toHaveLength(1);
    });

    it('answers with an error when GitHub rejects a review of only a summary', async () => {
      const { session } = await ok<{ session: string }>(routine, 'create_session', { repo: 'acme/widgets', pr: 1 });
      const { thread } = await ok<{ thread: string }>(routine, 'general_comment', { session, body: 'Only a summary.' });
      github.failReviewWith = 422;
      try {
        expect(await failed(routine, 'post_review', { session, event: 'COMMENT' })).toContain('Nothing was posted');
      } finally {
        github.failReviewWith = null;
        await ok(routine, 'dismiss', { id: thread });
      }
    });

    it('forgets the installation GitHub refused the token of, and says when the App is not installed', async () => {
      const { session } = await ok<{ session: string }>(routine, 'create_session', { repo: 'acme/widgets', pr: 1 });
      const { thread } = await ok<{ thread: string }>(routine, 'general_comment', { session, body: 'Refused.' });
      try {
        github.failReviewWith = 401;
        expect(await failed(routine, 'post_review', { session, event: 'COMMENT' })).toContain('401');
        github.failReviewWith = null;
        delete github.installations['acme/widgets'];
        expect(await failed(routine, 'post_review', { session, event: 'COMMENT' })).toBe(
          `The diffity GitHub App is not installed on acme/widgets; install it at ${github.url}/apps/diffity/installations/new`,
        );
      } finally {
        github.failReviewWith = null;
        github.installations['acme/widgets'] = 7;
        await ok(routine, 'dismiss', { id: thread });
      }
    });

    it('refuses once the pull request has moved past the session', async () => {
      const { session } = await ok<{ session: string }>(routine, 'create_session', { repo: 'acme/widgets', pr: 1 });
      pulls[1].headSha = fixture.head2;
      try {
        expect(await failed(routine, 'post_review', { session, event: 'REQUEST_CHANGES', body: 'Changes, please' })).toContain('moved on');
      } finally {
        pulls[1].headSha = fixture.head1;
      }
    });
  });
});
