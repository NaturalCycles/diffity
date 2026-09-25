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

async function mcpClient(accessToken: string): Promise<Client> {
  const transport = new StreamableHTTPClientTransport(new URL(`${server.base}/mcp`), {
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

beforeAll(async () => {
  fixture = makeFixture();
  github = await startFakeGitHub([
    {
      owner: 'acme',
      name: 'widgets',
      private: true,
      tokens: ['alice-token', 'bob-token'],
      pulls: { 1: { title: 'Change line ten', baseSha: fixture.mainTip, headSha: fixture.head1 } },
    },
  ]);
  dataDir = tempDir('mcp');
  server = await startTestServer(dataDir, github.url, { remoteUrl: fixture.remoteUrl, uiDir: fakeUiDir(dataDir) });
  const aliceCookie = await login(server.base, 'alice@example.com');
  const bobCookie = await login(server.base, 'bob@example.com');
  server.users.setGitHubToken(server.users.findOrCreate('alice@example.com').id, 'alice-token');
  server.users.setGitHubToken(server.users.findOrCreate('bob@example.com').id, 'bob-token');
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
      'amend', 'comment', 'create_session', 'dismiss', 'general_comment', 'get_diff', 'get_file', 'get_standards',
      'list_comments', 'list_sessions', 'reply', 'resolve', 'review_done', 'review_start', 'tour_delete', 'tour_done',
      'tour_start', 'tour_step',
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

  it('turns every mistake into a readable error result', async () => {
    expect(await failed(alice, 'create_session', { repo: 'acme/widgets' })).toContain('exactly one of');
    expect(await failed(alice, 'create_session', { repo: 'acme/nothing', pr: 1 })).toContain('cannot read it');
    expect(await failed(alice, 'get_diff', { session: 'deadbeef' })).toContain('No session matches');
    expect(await failed(alice, 'reply', { id: 'deadbeef', body: 'x' })).toContain('No thread matches');
    expect(await failed(alice, 'amend', { id: 'deadbeef', body: 'x' })).toContain('No comment or thread');
    expect(await failed(alice, 'tour_done', { tour: 'deadbeef' })).toContain('No walkthrough');
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
