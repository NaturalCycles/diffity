import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// A pull request controls its file names, and a reviewer opening the diff is enough to reach
// every helper below.
const HOSTILE_NAME = 'evil$(touch PWNED).txt';
// git itself rejects a branch name containing parentheses, but nothing stops this arriving
// as `/api/diff?ref=…`, and it reaches git without ever having to name a real branch.
const HOSTILE_REF = '$(touch PWNED_REF)';

let repoDir: string;
let origCwd: string;

function git(args: string[]): string {
  return execFileSync('git', args, { cwd: repoDir, encoding: 'utf-8', stdio: 'pipe' }).trim();
}

beforeAll(() => {
  origCwd = process.cwd();
  repoDir = mkdtempSync(join(tmpdir(), 'diffity-injection-'));

  execFileSync('git', ['init', '-b', 'main', repoDir], { stdio: 'pipe' });
  git(['config', 'user.email', 'test@test.com']);
  git(['config', 'user.name', 'Test']);

  writeFileSync(join(repoDir, HOSTILE_NAME), 'one\n');
  git(['add', '.']);
  git(['commit', '-m', 'hostile file name']);

  writeFileSync(join(repoDir, HOSTILE_NAME), 'two\n');
  git(['add', '.']);
  git(['commit', '-m', 'change it']);

  process.chdir(repoDir);
});

afterAll(() => {
  process.chdir(origCwd);
  rmSync(repoDir, { recursive: true, force: true });
});

function assertNothingExecuted(): void {
  expect(existsSync(join(repoDir, 'PWNED'))).toBe(false);
  expect(existsSync(join(repoDir, 'PWNED_REF'))).toBe(false);
}

describe('a file name containing a shell substitution', () => {
  it('is read as a path, not executed', async () => {
    const { getFileContent, getFileLineCount } = await import('../src/diff.js');

    expect(getFileContent(HOSTILE_NAME, 'HEAD')).toContain('two');
    expect(getFileLineCount(HOSTILE_NAME, 'HEAD')).toBe(1);
    assertNothingExecuted();
  });

  it('survives the diff helpers', async () => {
    const { getDiff, getDiffFiles, getDiffStat } = await import('../src/diff.js');

    expect(getDiffFiles('HEAD~1')).toContain(HOSTILE_NAME);
    expect(getDiff(['HEAD~1'])).toContain(HOSTILE_NAME);
    expect(getDiffStat(['HEAD~1'])).toContain('PWNED');
    assertNothingExecuted();
  });
});

describe('a ref containing a shell substitution', () => {
  it('is rejected as an unknown ref, not executed', async () => {
    const { getMergeBase, normalizeRef } = await import('../src/diff.js');

    expect(() => getMergeBase(HOSTILE_REF, 'HEAD')).toThrow();
    expect(() => normalizeRef(HOSTILE_REF)).toThrow();
    assertNothingExecuted();
  });
});

describe('a commit search term containing a shell substitution', () => {
  it('is passed to --grep, not executed', async () => {
    const { getRecentCommits } = await import('../src/commits.js');

    expect(getRecentCommits({ count: 10, search: '$(touch PWNED)' })).toEqual([]);
    assertNothingExecuted();
  });

  it('parses commits without stray quotes in the format', async () => {
    const { getRecentCommits } = await import('../src/commits.js');
    const [head] = getRecentCommits({ count: 1 });

    expect(head.hash).toHaveLength(40);
    expect(head.message).toBe('change it');
  });
});
