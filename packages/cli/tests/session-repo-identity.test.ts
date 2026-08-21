import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

let root: string;
let repoA: string;
let repoB: string;
let origCwd: string;

function makeRepo(path: string): void {
  execFileSync('git', ['init', '-b', 'main', path], { stdio: 'pipe' });
  execFileSync('git', ['config', 'user.email', 't@t'], { cwd: path, stdio: 'pipe' });
  execFileSync('git', ['config', 'user.name', 'T'], { cwd: path, stdio: 'pipe' });
  writeFileSync(join(path, 'a.txt'), 'a\n');
  execFileSync('git', ['add', '.'], { cwd: path, stdio: 'pipe' });
  execFileSync('git', ['commit', '-m', 'init'], { cwd: path, stdio: 'pipe' });
}

beforeAll(() => {
  origCwd = process.cwd();
  root = mkdtempSync(join(tmpdir(), 'diffity-two-repos-'));
  repoA = join(root, 'a');
  repoB = join(root, 'b');
  makeRepo(repoA);
  makeRepo(repoB);
  // Both repositories share one data directory, which is what a reviewer-wide dataDir means.
  process.env.DIFFITY_DATA_DIR = join(root, 'notes');
});

afterAll(() => {
  process.chdir(origCwd);
  delete process.env.DIFFITY_DATA_DIR;
  rmSync(root, { recursive: true, force: true });
});

describe('two repositories sharing one data directory', () => {
  it('do not carry each other threads when their refs are named alike', async () => {
    const { findOrCreateSession } = await import('../src/session.js');
    const { createThread, getThreadsForSession } = await import('../src/threads.js');

    process.chdir(repoA);
    const inA = findOrCreateSession('work');
    const threadInA = createThread(inA.id, 'a.txt', 'new', 1, 1, 'about repo A', {
      name: 'Agent',
      type: 'agent',
    });

    process.chdir(repoB);
    const inB = findOrCreateSession('work');

    expect(inB.id).not.toBe(inA.id);
    expect(getThreadsForSession(inB.id)).toEqual([]);
    expect(getThreadsForSession(inA.id).map(t => t.id)).toEqual([threadInA.id]);
  });

  it('do not resolve each other stale session ids', async () => {
    const { findOrCreateSession, resolveSessionId } = await import('../src/session.js');

    process.chdir(repoA);
    const inA = findOrCreateSession('work');
    process.chdir(repoB);
    const inB = findOrCreateSession('work');

    // Asking repo B about repo A's session must not hand back B's session.
    expect(resolveSessionId(inA.id)).not.toBe(inB.id);
  });

  it('still carries a session forward within one repository', async () => {
    const { findOrCreateSession } = await import('../src/session.js');
    const { createThread, getThreadsForSession } = await import('../src/threads.js');

    process.chdir(repoA);
    const before = findOrCreateSession('work');
    const finding = createThread(before.id, 'a.txt', 'new', 1, 1, 'still open', {
      name: 'Agent',
      type: 'agent',
    });

    writeFileSync(join(repoA, 'b.txt'), 'b\n');
    execFileSync('git', ['add', '.'], { cwd: repoA, stdio: 'pipe' });
    execFileSync('git', ['commit', '-m', 'move head'], { cwd: repoA, stdio: 'pipe' });

    const after = findOrCreateSession('work');
    expect(after.id).not.toBe(before.id);
    expect(getThreadsForSession(after.id).map(t => t.id)).toContain(finding.id);
  });
});
