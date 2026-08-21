import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { getTree, getTreeFingerprint } from '../src/tree';

/**
 * Node's default maxBuffer is 1 MB. A repository whose file listing is larger
 * than that used to kill `git ls-files` with ENOBUFS, which surfaced as
 * "Failed to get tree" for every large repo.
 */
const DEFAULT_MAX_BUFFER = 1024 * 1024;

let repoDir: string;
let origCwd: string;

function git(cmd: string) {
  // This fixture is deliberately larger than the default 1 MB buffer, and
  // `git commit` names every file it creates — so the setup needs the same
  // headroom the code under test does.
  execSync(`git ${cmd}`, {
    cwd: repoDir,
    stdio: 'pipe',
    maxBuffer: 50 * 1024 * 1024,
  });
}

beforeAll(() => {
  origCwd = process.cwd();
  repoDir = mkdtempSync(join(tmpdir(), 'diffity-large-tree-'));

  git('init -b main');
  git('config user.email "test@test.com"');
  git('config user.name "Test"');

  // Enough path bytes to exceed the default buffer: names are padded so the
  // listing crosses 1 MB without needing tens of thousands of files.
  const padding = 'p'.repeat(180);
  mkdirSync(join(repoDir, 'many'));
  for (let i = 0; i < 6000; i += 1) {
    writeFileSync(join(repoDir, 'many', `f${i}-${padding}.txt`), '');
  }
  git('add .');
  git('commit -m "many files"');

  process.chdir(repoDir);
});

afterAll(() => {
  process.chdir(origCwd);
  rmSync(repoDir, { recursive: true, force: true });
});

describe('a repository whose listing exceeds the default buffer', () => {
  it('lists every file rather than throwing ENOBUFS', () => {
    const paths = getTree();

    expect(paths).toHaveLength(6000);
    expect(paths.join('\n').length).toBeGreaterThan(DEFAULT_MAX_BUFFER);
  });

  it('still fingerprints the tree', () => {
    expect(getTreeFingerprint()).toMatch(/^\d+:/);
  });
});
