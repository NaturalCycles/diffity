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

/** What the page's heartbeat does. Ordinary traffic no longer counts, since a hidden tab makes none. */
function pageIsOpen(): Promise<{ status: number; body: any }> {
  return req('/api/viewer', { method: 'POST' });
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
    await pageIsOpen();

    const started = Date.now();
    const { body } = await claim(2);

    expect(body.viewerPresent).toBe(true);
    expect(Date.now() - started).toBeGreaterThanOrEqual(1_500);
  });

  // Silence is not absence: react query stops polling a hidden tab, so a window can be open and
  // making no requests at all. Only the heartbeat counts.
  it('does not take ordinary traffic as proof a window is open', async () => {
    const { resetViewerSeen } = await import('../src/viewers.js');
    resetViewerSeen();

    await req('/api/info');
    const { body } = await claim(0);

    expect(body.viewerPresent).toBe(false);
    expect(body.viewerGone).toBe(false);
  });

  // The precise signal, which is what the whole thing turns on.
  it('knows at once when the page says it is closing', async () => {
    await pageIsOpen();
    expect((await claim(0)).body.viewerPresent).toBe(true);

    await req('/api/viewer/gone', { method: 'POST' });

    const { body } = await claim(30);
    expect(body.viewerGone).toBe(true);
    expect(body.viewerPresent).toBe(false);
  });
});

describe('what the agent missed while it was parked', () => {
  it('reports nothing on a quiet session', async () => {
    await pageIsOpen();
    const { body } = await claim(0);

    expect(body.since).toEqual({ submitted: 0 });
  });

  it('reports a finding that went to the forge, once', async () => {
    await pageIsOpen();
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
    await pageIsOpen();
    const second = await claim(0);
    expect(second.body.since.submitted).toBe(0);
  });
});
