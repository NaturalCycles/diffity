import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

let root: string;
let repoDir: string;
let origCwd: string;

beforeAll(() => {
  origCwd = process.cwd();
  root = mkdtempSync(join(tmpdir(), 'diffity-purpose-'));
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
});

afterAll(() => {
  process.chdir(origCwd);
  delete process.env.DIFFITY_DATA_DIR;
  rmSync(root, { recursive: true, force: true });
});

async function statusWith(purpose?: 'work' | 'review') {
  const { startServer } = await import('../src/server.js');
  const started = await startServer({ port: 0, diffArgs: [], effectiveRef: 'work', purpose });
  try {
    const res = await fetch(`http://127.0.0.1:${started.port}/api/live/status`);
    return (await res.json()) as { mayChangeCode: boolean };
  } finally {
    started.close();
  }
}

describe('what the launcher said it was here for', () => {
  // The flag is parsed in index.ts, carried through ServerOptions and read in two places. All of
  // that was verified by hand and by nothing else, on the path that decides whether an agent may
  // edit somebody else's branch.
  it('reaches the page as permission to change code', async () => {
    expect((await statusWith('work')).mayChangeCode).toBe(true);
  });

  it('reaches the page as a refusal', async () => {
    expect((await statusWith('review')).mayChangeCode).toBe(false);
  });

  // No pull request here, so authorship says it is the reader's own working tree.
  it('falls back to authorship when nothing was said', async () => {
    expect((await statusWith()).mayChangeCode).toBe(true);
  });
});
