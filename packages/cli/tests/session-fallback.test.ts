import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

let root: string;
let repoDir: string;
let origCwd: string;

beforeAll(() => {
  origCwd = process.cwd();
  root = mkdtempSync(join(tmpdir(), 'diffity-fallback-'));
  repoDir = join(root, 'repo');
  execFileSync('git', ['init', '-b', 'main', repoDir], { stdio: 'pipe' });
  execFileSync('git', ['config', 'user.email', 't@t'], { cwd: repoDir, stdio: 'pipe' });
  execFileSync('git', ['config', 'user.name', 'T'], { cwd: repoDir, stdio: 'pipe' });
  writeFileSync(join(repoDir, 'a.txt'), 'a\n');
  execFileSync('git', ['add', '.'], { cwd: repoDir, stdio: 'pipe' });
  execFileSync('git', ['commit', '-m', 'init'], { cwd: repoDir, stdio: 'pipe' });
  process.env.DIFFITY_DATA_DIR = join(root, 'notes');
  process.chdir(repoDir);
});

afterAll(() => {
  process.chdir(origCwd);
  delete process.env.DIFFITY_DATA_DIR;
  rmSync(root, { recursive: true, force: true });
});

describe('resolveSessionId', () => {
  it('falls back to the current session when the client names none', async () => {
    const { findOrCreateSession, resolveSessionId } = await import('../src/session.js');
    const session = findOrCreateSession('work');

    expect(resolveSessionId(null)).toBe(session.id);
    expect(resolveSessionId(undefined)).toBe(session.id);
  });

  it('follows a superseded session to the one that took its threads', async () => {
    const { findOrCreateSession, resolveSessionId, carryForward } = await import('../src/session.js');
    const old = findOrCreateSession('work');

    writeFileSync(join(repoDir, 'b.txt'), 'b\n');
    execFileSync('git', ['add', '.'], { cwd: repoDir, stdio: 'pipe' });
    execFileSync('git', ['commit', '-m', 'move head'], { cwd: repoDir, stdio: 'pipe' });
    const fresh = findOrCreateSession('work');

    expect(fresh.id).not.toBe(old.id);
    // A browser tab still holding the old id must not be told the review is empty.
    expect(resolveSessionId(old.id)).toBe(fresh.id);
    expect(carryForward).toBeTypeOf('function');
  });

  it('leaves an unknown session alone rather than inventing one', async () => {
    const { resolveSessionId } = await import('../src/session.js');

    expect(resolveSessionId('not-a-session')).toBe('not-a-session');
  });
});
