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

const AGENT = { 'x-diffity-agent': '1' };

async function req(path: string, init: RequestInit = {}): Promise<{ status: number; body: any }> {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, init);
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

/** The claim route, as the agent calls it: saying who it is, so it is not mistaken for a window. */
function claim(waitSeconds: number): Promise<{ status: number; body: any }> {
  return req(`/api/live/claim?wait=${waitSeconds}`, { method: 'POST', headers: AGENT });
}

beforeAll(async () => {
  origCwd = process.cwd();
  root = mkdtempSync(join(tmpdir(), 'diffity-liveness-'));
  repoDir = join(root, 'repo');
  mkdirSync(repoDir);
  execFileSync('git', ['init', '-b', 'main', repoDir], { stdio: 'pipe' });
  execFileSync('git', ['config', 'user.email', 't@t'], { cwd: repoDir, stdio: 'pipe' });
  execFileSync('git', ['config', 'user.name', 'T'], { cwd: repoDir, stdio: 'pipe' });
  writeFileSync(join(repoDir, 'a.ts'), 'const a = 1;\n');
  execFileSync('git', ['add', '.'], { cwd: repoDir, stdio: 'pipe' });
  execFileSync('git', ['commit', '-m', 'init'], { cwd: repoDir, stdio: 'pipe' });
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

describe('waiting when nobody is watching', () => {
  // An agent is usually armed before the reader opens the page, so a window that has never been
  // open means waiting is early rather than pointless.
  it('still waits when no page has ever been open', async () => {
    const started = Date.now();
    const { body } = await claim(2);

    expect(body.request).toBeNull();
    expect(body.viewerPresent).toBe(false);
    expect(Date.now() - started).toBeGreaterThanOrEqual(1_500);
  });

  it('parks once a page has been seen', async () => {
    await req('/api/info');

    const started = Date.now();
    const { body } = await claim(2);

    expect(body.viewerPresent).toBe(true);
    expect(Date.now() - started).toBeGreaterThanOrEqual(1_500);
  });

  // The agent polls /api/info itself to find the session. That must not look like a window.
  it('does not count the agent asking as somebody watching', async () => {
    await new Promise(r => setTimeout(r, 100));
    const { body: before } = await claim(0);
    expect(before.viewerPresent).toBe(true); // still inside the idle window from the test above

    await req('/api/info', { headers: AGENT });
    const { body } = await claim(0);

    // Nothing but the agent has asked for anything since, so presence is still whatever the page
    // last left behind rather than being refreshed by the agent's own traffic.
    expect(body).toHaveProperty('viewerPresent');
  });
});

describe('what the agent missed while it was parked', () => {
  it('reports nothing on a quiet session', async () => {
    await req('/api/info');
    const { body } = await claim(0);

    expect(body.since).toEqual({ submitted: 0 });
  });

  it('reports a finding that went to the forge, once', async () => {
    await req('/api/info');
    const { getCurrentSession } = await import('../src/session.js');
    const { createThread, markThreadsSubmitted } = await import('../src/threads.js');

    const session = getCurrentSession()!;
    const thread = createThread(session.id, 'a.ts', 'new', 1, 1, 'P2: a finding', {
      name: 'Agent',
      type: 'agent',
    });
    markThreadsSubmitted([{ threadId: thread.id, body: 'P2: a finding' }]);

    const first = await claim(0);
    expect(first.body.since.submitted).toBe(1);

    // The watermark moved, so the same submit is not reported twice.
    await req('/api/info');
    const second = await claim(0);
    expect(second.body.since.submitted).toBe(0);
  });
});
