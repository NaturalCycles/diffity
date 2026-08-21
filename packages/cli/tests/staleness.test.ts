import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

let root: string;
let repoDir: string;
let origCwd: string;

function git(args: string[]): string {
  return execFileSync('git', args, { cwd: repoDir, encoding: 'utf-8', stdio: 'pipe' }).trim();
}

function commit(name: string, content: string): void {
  writeFileSync(join(repoDir, name), content);
  git(['add', '.']);
  git(['commit', '-m', name]);
}

beforeAll(() => {
  origCwd = process.cwd();
  root = mkdtempSync(join(tmpdir(), 'diffity-stale-'));
  repoDir = join(root, 'repo');
  execFileSync('git', ['init', '-b', 'main', repoDir], { stdio: 'pipe' });
  execFileSync('git', ['config', 'user.email', 't@t'], { cwd: repoDir, stdio: 'pipe' });
  execFileSync('git', ['config', 'user.name', 'T'], { cwd: repoDir, stdio: 'pipe' });
  commit('base.txt', 'base\n');
  git(['tag', 'start']);
  process.env.DIFFITY_DATA_DIR = join(root, 'notes');
  process.chdir(repoDir);
});

afterAll(() => {
  process.chdir(origCwd);
  delete process.env.DIFFITY_DATA_DIR;
  rmSync(root, { recursive: true, force: true });
});

describe('diff fingerprint', () => {
  it('changes when a commit rewrites the same number of lines', async () => {
    const { computeDiffFingerprint } = await import('../src/fingerprint.js');

    commit('a.txt', 'one\ntwo\n');
    const before = computeDiffFingerprint('start');

    // Same line counts, different content — a diffstat alone cannot tell these apart.
    commit('a.txt', 'one\nTWO\n');
    const after = computeDiffFingerprint('start');

    expect(after).not.toBe(before);
  });

  it('is stable when nothing changed', async () => {
    const { computeDiffFingerprint } = await import('../src/fingerprint.js');

    expect(computeDiffFingerprint('start')).toBe(computeDiffFingerprint('start'));
  });
});
