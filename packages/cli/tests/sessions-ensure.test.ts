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

async function req(path: string, init: RequestInit = {}): Promise<{ status: number; body: any }> {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, init);
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

beforeAll(async () => {
  origCwd = process.cwd();
  root = mkdtempSync(join(tmpdir(), 'diffity-ensure-'));
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

describe('POST /api/sessions/ensure', () => {
  it("answers with the server's own session", async () => {
    const { status, body } = await req('/api/sessions/ensure', { method: 'POST' });

    expect(status).toBe(200);
    expect(body.ref).toBe('work');
    expect(body.id).toBeTruthy();
    expect(body.headHash).toBeTruthy();
  });

  it('answers the same session the info route names', async () => {
    const ensured = await req('/api/sessions/ensure', { method: 'POST' });
    const info = await req('/api/info?ref=work');

    expect(ensured.body.id).toBe(info.body.sessionId);
  });

  it('is idempotent', async () => {
    const first = await req('/api/sessions/ensure', { method: 'POST' });
    const second = await req('/api/sessions/ensure', { method: 'POST' });

    expect(second.body.id).toBe(first.body.id);
  });
});

describe('the session ensure follows the reader to', () => {
  it("is the tree once a page poll names the tree, and the agent's own polls change nothing", async () => {
    const before = await req('/api/sessions/ensure', { method: 'POST' });
    expect(before.body.ref).toBe('work');

    // The tree page polls its info route; the server now knows where the reader is.
    await req('/api/tree/info');
    const afterTree = await req('/api/sessions/ensure', { method: 'POST' });
    expect(afterTree.body.ref).toBe('__tree__');
    expect(afterTree.body.id).not.toBe(before.body.id);

    // An agent's info poll is not a reader; it must not steal the ensure back.
    await req('/api/info?ref=work', { headers: { 'x-diffity-agent': '1' } });
    const still = await req('/api/sessions/ensure', { method: 'POST' });
    expect(still.body.ref).toBe('__tree__');

    // A page poll for the diff brings the ensure back to it.
    await req('/api/info?ref=work');
    const back = await req('/api/sessions/ensure', { method: 'POST' });
    expect(back.body.id).toBe(before.body.id);
  });
});
