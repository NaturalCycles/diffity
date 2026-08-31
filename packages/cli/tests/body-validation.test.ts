import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

let root: string;
let repoDir: string;
let origCwd: string;
let port: number;
let close: () => void;
let sessionId: string;

function git(args: string[]): void {
  execFileSync('git', args, { cwd: repoDir, stdio: 'pipe' });
}

async function req(
  path: string,
  init: RequestInit = {},
): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    headers: { 'Content-Type': 'application/json' },
    ...init,
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : {} };
}

beforeAll(async () => {
  origCwd = process.cwd();
  root = mkdtempSync(join(tmpdir(), 'diffity-validate-'));
  repoDir = join(root, 'repo');
  mkdirSync(repoDir);

  execFileSync('git', ['init', '-b', 'main', repoDir], { stdio: 'pipe' });
  git(['config', 'user.email', 't@t']);
  git(['config', 'user.name', 'T']);
  writeFileSync(join(repoDir, 'a.ts'), 'const a = 1;\n');
  git(['add', '.']);
  git(['commit', '-m', 'init']);
  writeFileSync(join(repoDir, 'a.ts'), 'const a = 2;\n');

  process.env.DIFFITY_DATA_DIR = join(root, 'notes');
  process.chdir(repoDir);

  const { startServer } = await import('../src/server.js');
  const started = await startServer({ port: 0, diffArgs: [], effectiveRef: 'work' });
  port = started.port;
  close = started.close;

  const ensured = await req('/api/sessions/ensure', { method: 'POST' });
  sessionId = ensured.body.id as string;
});

afterAll(() => {
  close?.();
  process.chdir(origCwd);
  delete process.env.DIFFITY_DATA_DIR;
  rmSync(root, { recursive: true, force: true });
});

function threadBody(over: Record<string, unknown> = {}): string {
  return JSON.stringify({
    sessionId,
    filePath: 'a.ts',
    side: 'new',
    startLine: 1,
    endLine: 1,
    body: 'a comment',
    author: { name: 'You', type: 'user' },
    ...over,
  });
}

describe('what the thread routes accept', () => {
  it('creates a thread from a well-formed body', async () => {
    const { status, body } = await req('/api/threads', { method: 'POST', body: threadBody() });

    expect(status).toBe(200);
    expect(body.filePath).toBe('a.ts');
  });

  it('refuses an author that is not one, naming the field', async () => {
    const { status, body } = await req('/api/threads', {
      method: 'POST',
      body: threadBody({ author: { name: 1 } }),
    });

    expect(status).toBe(400);
    expect(body.error).toContain('author.name');
  });

  it('refuses a side that is neither old nor new', async () => {
    const { status, body } = await req('/api/threads', {
      method: 'POST',
      body: threadBody({ side: 'sideways' }),
    });

    expect(status).toBe(400);
    expect(body.error).toBe('side must be one of: old, new');
  });

  it('answers 400, not 500, to a body that is not JSON', async () => {
    const { status, body } = await req('/api/threads', { method: 'POST', body: '{not json' });

    expect(status).toBe(400);
    expect(body.error).toBe('Request body must be valid JSON');
  });

  it('answers 400 to a JSON body that is not an object', async () => {
    const { status } = await req('/api/threads', { method: 'POST', body: 'null' });

    expect(status).toBe(400);
  });

  it('refuses an intent that is neither ask nor act on a reply', async () => {
    const created = await req('/api/threads', { method: 'POST', body: threadBody() });
    const { status, body } = await req(`/api/threads/${created.body.id}/reply`, {
      method: 'POST',
      body: JSON.stringify({ body: 'x', author: { name: 'You', type: 'user' }, intent: 'demand' }),
    });

    expect(status).toBe(400);
    expect(body.error).toBe('intent must be one of: ask, act');
  });

  it('refuses a status the schema does not know, on PATCH and on GET alike', async () => {
    const created = await req('/api/threads', { method: 'POST', body: threadBody() });
    const patched = await req(`/api/threads/${created.body.id}/status`, {
      method: 'PATCH',
      body: JSON.stringify({ status: 'zapped' }),
    });
    const listed = await req(`/api/threads?session=${sessionId}&status=zapped`);

    expect(patched.status).toBe(400);
    expect(listed.status).toBe(400);
    expect(listed.body.error).toBe('status must be one of: open, resolved, dismissed');
  });

  it('still resolves a thread the ordinary way', async () => {
    const created = await req('/api/threads', { method: 'POST', body: threadBody() });
    const patched = await req(`/api/threads/${created.body.id}/status`, {
      method: 'PATCH',
      body: JSON.stringify({ status: 'resolved', summary: 'done' }),
    });

    expect(patched.status).toBe(200);
    const listed = await req(`/api/threads?session=${sessionId}&status=resolved`);
    const ids = (listed.body as unknown as { id: string }[]).map(thread => thread.id);
    expect(ids).toContain(created.body.id);
  });

  it('refuses an edit with no body text', async () => {
    const created = await req('/api/threads', { method: 'POST', body: threadBody() });
    const comment = (created.body.comments as { id: string }[])[0];
    const { status, body } = await req(`/api/comments/${comment.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ body: '' }),
    });

    expect(status).toBe(400);
    expect(body.error).toContain('body');
  });
});

describe('what the tour routes accept', () => {
  it('refuses a tour without a topic', async () => {
    const { status, body } = await req('/api/tours', {
      method: 'POST',
      body: JSON.stringify({ sessionId }),
    });

    expect(status).toBe(400);
    expect(body.error).toContain('topic');
  });

  it('refuses a step on a fractional line', async () => {
    const tour = await req('/api/tours', {
      method: 'POST',
      body: JSON.stringify({ sessionId, topic: 'Reading order' }),
    });
    const { status, body } = await req(`/api/tours/${tour.body.id}/steps`, {
      method: 'POST',
      body: JSON.stringify({ filePath: 'a.ts', startLine: 1.5, endLine: 2 }),
    });

    expect(status).toBe(400);
    expect(body.error).toContain('startLine');
  });

  it('refuses a tour status it does not know', async () => {
    const tour = await req('/api/tours', {
      method: 'POST',
      body: JSON.stringify({ sessionId, topic: 'Reading order' }),
    });
    const { status, body } = await req(`/api/tours/${tour.body.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ status: 'done' }),
    });

    expect(status).toBe(400);
    expect(body.error).toBe('status must be one of: building, ready');
  });
});

describe('what the working-tree routes accept', () => {
  it('refuses a revert of a filePath that is not a string', async () => {
    const { status, body } = await req('/api/revert-file', {
      method: 'POST',
      body: JSON.stringify({ filePath: 42 }),
    });

    expect(status).toBe(400);
    expect(body.error).toContain('filePath');
  });

  it('refuses an empty patch', async () => {
    const { status, body } = await req('/api/revert-hunk', {
      method: 'POST',
      body: JSON.stringify({ patch: '' }),
    });

    expect(status).toBe(400);
    expect(body.error).toContain('patch');
  });
});
