import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

let root: string;
let repoDir: string;
let origCwd: string;

beforeAll(() => {
  origCwd = process.cwd();
  root = mkdtempSync(join(tmpdir(), 'diffity-contain-'));
  repoDir = join(root, 'repo');
  mkdirSync(repoDir);

  execFileSync('git', ['init', '-b', 'main', repoDir], { stdio: 'pipe' });
  writeFileSync(join(repoDir, 'inside.txt'), 'inside\n');
  writeFileSync(join(root, 'outside.txt'), 'outside\n');

  process.chdir(repoDir);
});

afterAll(() => {
  process.chdir(origCwd);
  rmSync(root, { recursive: true, force: true });
});

describe('resolveInRepo', () => {
  it('resolves a path inside the repository', async () => {
    const { resolveInRepo } = await import('../src/tree.js');

    expect(resolveInRepo('inside.txt')).toBe(join(repoDir, 'inside.txt'));
  });

  it('rejects a traversal out of the repository', async () => {
    const { resolveInRepo } = await import('../src/tree.js');

    // What `decodeURIComponent('..%2f..%2fetc%2fpasswd')` hands the handler.
    expect(() => resolveInRepo('../outside.txt')).toThrow(/escapes the repository/);
    expect(() => resolveInRepo('../../../../etc/passwd')).toThrow(/escapes the repository/);
  });

  it('rejects an absolute path outside the repository', async () => {
    const { resolveInRepo } = await import('../src/tree.js');

    expect(() => resolveInRepo('/etc/passwd')).toThrow(/escapes the repository/);
  });

  it('rejects a sibling directory sharing the repository name as a prefix', async () => {
    const { resolveInRepo } = await import('../src/tree.js');

    expect(() => resolveInRepo('../repo-evil/secret.txt')).toThrow(/escapes the repository/);
  });

  it('refuses to read outside the repository through the file readers', async () => {
    const { getWorkingTreeFileContent } = await import('../src/tree.js');

    expect(() => getWorkingTreeFileContent('../outside.txt')).toThrow(/escapes the repository/);
  });
});
