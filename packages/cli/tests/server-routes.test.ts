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

function git(args: string[]): void {
  execFileSync('git', args, { cwd: repoDir, stdio: 'pipe' });
}

async function req(
  path: string,
  init: RequestInit = {},
): Promise<{ status: number; headers: Headers; text: string }> {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, init);
  return { status: res.status, headers: res.headers, text: await res.text() };
}

beforeAll(async () => {
  origCwd = process.cwd();
  root = mkdtempSync(join(tmpdir(), 'diffity-routes-'));
  repoDir = join(root, 'repo');
  mkdirSync(repoDir);

  execFileSync('git', ['init', '-b', 'main', repoDir], { stdio: 'pipe' });
  git(['config', 'user.email', 't@t']);
  git(['config', 'user.name', 'T']);
  writeFileSync(join(repoDir, 'a.ts'), 'const a = 1;\n');
  writeFileSync(join(root, 'outside.txt'), 'not in the repo\n');
  git(['add', '.']);
  git(['commit', '-m', 'init']);
  writeFileSync(join(repoDir, 'a.ts'), 'const a = 2;\n');

  process.env.DIFFITY_DATA_DIR = join(root, 'notes');
  process.chdir(repoDir);

  const { startServer } = await import('../src/server.js');
  const started = await startServer({ port: 0, diffArgs: [], effectiveRef: 'work' });
  port = started.port;
  close = started.close;
});

afterAll(() => {
  close?.();
  process.chdir(origCwd);
  delete process.env.DIFFITY_DATA_DIR;
  rmSync(root, { recursive: true, force: true });
});

describe('every response', () => {
  it('carries a content security policy that still allows the highlighter its wasm', async () => {
    const { headers } = await req('/api/info');
    const csp = headers.get('content-security-policy') ?? '';

    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("frame-src 'none'");
    expect(csp).toContain("connect-src 'self'");
    expect(csp).toContain("'wasm-unsafe-eval'");
  });

  it('sends no cross-origin permission at all', async () => {
    const { headers } = await req('/api/info');

    expect(headers.get('access-control-allow-origin')).toBeNull();
    expect(headers.get('x-content-type-options')).toBe('nosniff');
  });
});

describe('writes from another origin', () => {
  it('are refused', async () => {
    const { status } = await req('/api/threads', {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain', 'Sec-Fetch-Site': 'cross-site' },
      body: JSON.stringify({ sessionId: 'x' }),
    });

    expect(status).toBe(403);
  });

  it('are allowed from the page itself', async () => {
    const { status } = await req('/api/threads', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Sec-Fetch-Site': 'same-origin' },
      body: JSON.stringify({}),
    });

    // Reaches the handler, which rejects it on its merits rather than its origin.
    expect(status).toBe(400);
  });
});

describe('reading files', () => {
  it('refuses a percent-encoded escape from the repository', async () => {
    const { status } = await req('/api/tree/raw/..%2f..%2foutside.txt');

    expect(status).toBe(404);
  });

  it('refuses an absolute path', async () => {
    const { status } = await req('/api/tree/raw/%2fetc%2fpasswd');

    expect(status).toBe(404);
  });

  it('serves a file inside the repository, inertly', async () => {
    const { status, headers } = await req('/api/tree/raw/a.ts');

    expect(status).toBe(200);
    expect(headers.get('content-type')).toBe('application/octet-stream');
    expect(headers.get('content-disposition')).toBe('attachment');
  });
});

describe('the diff route', () => {
  it('describes the working tree', async () => {
    const { status, text } = await req('/api/diff');
    const diff = JSON.parse(text);

    expect(status).toBe(200);
    expect(diff.stats.filesChanged).toBe(1);
  });

  it('reports what whitespace hiding removed', async () => {
    const { text } = await req('/api/diff?whitespace=hide');

    expect(JSON.parse(text).suppressed).toEqual({ files: 0, lines: 0 });
  });

  it('answers threads without being told the session', async () => {
    const { status, text } = await req('/api/threads');

    expect(status).toBe(200);
    expect(JSON.parse(text)).toEqual([]);
  });
});

describe('where the server listens', () => {
  it('is loopback unless asked otherwise', async () => {
    const { getBindHost } = await import('../src/server.js');

    expect(getBindHost()).toBe('127.0.0.1');
  });

  it('can be widened deliberately', async () => {
    const { getBindHost } = await import('../src/server.js');
    process.env.DIFFITY_BIND = '0.0.0.0';

    expect(getBindHost()).toBe('0.0.0.0');

    delete process.env.DIFFITY_BIND;
  });

  it('is not affected by the hostname used in the printed url', async () => {
    const { getBindHost, getHost } = await import('../src/server.js');
    process.env.DIFFITY_HOST = 'diffity.local';

    expect(getHost()).toBe('diffity.local');
    expect(getBindHost()).toBe('127.0.0.1');

    delete process.env.DIFFITY_HOST;
  });
});

describe('the live loop', () => {
  async function newThread(): Promise<string> {
    const info = JSON.parse((await req('/api/info')).text) as { sessionId: string };
    const created = await req('/api/threads', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        sessionId: info.sessionId, filePath: 'a.ts', side: 'new',
        startLine: 1, endLine: 1, body: 'P2: a finding',
        author: { name: 'Agent', type: 'agent' },
      }),
    });
    return (JSON.parse(created.text) as { id: string }).id;
  }

  it('reports that nobody is listening', async () => {
    const info = JSON.parse((await req('/api/info')).text) as { live?: { listening: boolean } };

    expect(info.live?.listening).toBe(false);
  });

  it('has nothing to hand over when nothing was asked', async () => {
    const claim = await req('/api/live/claim?wait=0', { method: 'POST' });

    expect(claim.status).toBe(200);
    expect(JSON.parse(claim.text)).toEqual({ request: null });
  });

  it('hands over an aside that asked for the agent', async () => {
    const threadId = await newThread();
    await req(`/api/threads/${threadId}/reply`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        body: 'what do you mean by the marker?',
        author: { name: 'You', type: 'user' },
        kind: 'aside',
        live: true,
      }),
    });

    const claim = await req('/api/live/claim?wait=0', { method: 'POST' });
    const { request } = JSON.parse(claim.text) as { request: { body: string; findingBody: string } | null };

    expect(request?.body).toBe('what do you mean by the marker?');
    expect(request?.findingBody).toBe('P2: a finding');
  });

  it('does not hand over an aside that did not ask', async () => {
    const threadId = await newThread();
    await req(`/api/threads/${threadId}/reply`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        body: 'thinking aloud, not asking',
        author: { name: 'You', type: 'user' },
        kind: 'aside',
      }),
    });

    const claim = await req('/api/live/claim?wait=0', { method: 'POST' });

    expect(JSON.parse(claim.text)).toEqual({ request: null });
  });

  // Claiming mutates, so it must be a write as far as the guard is concerned.
  it('refuses a claim from a cross-origin page', async () => {
    const claim = await req('/api/live/claim?wait=0', {
      method: 'POST',
      headers: { 'sec-fetch-site': 'cross-site' },
    });

    expect(claim.status).toBe(403);
  });

  it('counts what is still waiting', async () => {
    const threadId = await newThread();
    for (const body of ['first', 'second']) {
      await req(`/api/threads/${threadId}/reply`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ body, author: { name: 'You', type: 'user' }, kind: 'aside', live: true }),
      });
    }

    const info = JSON.parse((await req('/api/info')).text) as { live?: { waiting: number } };

    expect(info.live?.waiting).toBe(2);
  });
});
