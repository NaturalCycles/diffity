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

beforeAll(async () => {
  origCwd = process.cwd();
  root = mkdtempSync(join(tmpdir(), 'diffity-gone-'));
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

// The whole point: a window was open, the reader closed the tab, and the next wait stops instead of
// parking for a question nobody can now ask.
describe('a window that was open and has gone', () => {
  it('is told apart from one that never opened, and stops the wait', async () => {
    const { noteViewerSeen, VIEWER_IDLE_MS } = await import('../src/viewers.js');

    // A page asked for something, long enough ago that its polling has clearly stopped.
    noteViewerSeen(Date.now() - VIEWER_IDLE_MS - 1);

    const started = Date.now();
    const res = await fetch(`http://127.0.0.1:${port}/api/live/claim?wait=30`, {
      method: 'POST',
      headers: AGENT,
    });
    const body = await res.json();

    expect(body.viewerPresent).toBe(false);
    expect(body.request).toBeNull();
    expect(Date.now() - started).toBeLessThan(3_000);
  });
});
