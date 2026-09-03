import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

let repoDir: string;
let origCwd: string;

function git(cmd: string) {
  execSync(`git ${cmd}`, { cwd: repoDir, stdio: 'pipe' });
}

function writeFile(name: string, content: string) {
  writeFileSync(join(repoDir, name), content);
}

beforeAll(() => {
  origCwd = process.cwd();
  repoDir = mkdtempSync(join(tmpdir(), 'diffity-test-'));

  git('init -b main');
  git('config user.email "test@test.com"');
  git('config user.name "Test"');

  writeFile('committed.txt', 'committed\n');
  writeFile('to-rename.txt', 'stable content that survives the rename\n');
  writeFile('to-delete.txt', 'doomed\n');
  writeFile('with space.txt', 'spaced\n');
  git('add .');
  git('commit -m "initial commit"');

  process.chdir(repoDir);
});

afterAll(() => {
  process.chdir(origCwd);
  rmSync(repoDir, { recursive: true, force: true });
});

describe('getDirtyPaths', () => {
  it('returns nothing in a clean tree', async () => {
    const { getDirtyPaths } = await import('../src/status.js');
    expect(getDirtyPaths()).toEqual([]);
  });

  it('reports unstaged, staged and untracked paths', async () => {
    const { getDirtyPaths } = await import('../src/status.js');
    writeFile('committed.txt', 'edited\n');
    writeFile('staged.txt', 'staged\n');
    git('add staged.txt');
    writeFile('untracked.txt', 'untracked\n');

    const paths = getDirtyPaths();
    expect(paths).toContain('committed.txt');
    expect(paths).toContain('staged.txt');
    expect(paths).toContain('untracked.txt');

    git('reset HEAD staged.txt');
    git('checkout -- committed.txt');
    rmSync(join(repoDir, 'staged.txt'));
    rmSync(join(repoDir, 'untracked.txt'));
  });

  it('reports an unstaged edit whose status column starts with a space', async () => {
    const { getDirtyPaths } = await import('../src/status.js');
    writeFile('committed.txt', 'edited\n');

    // ` M committed.txt` — a trimming parse would eat the leading space and shift the path.
    expect(getDirtyPaths()).toEqual(['committed.txt']);

    git('checkout -- committed.txt');
  });

  it('reports a deleted file', async () => {
    const { getDirtyPaths } = await import('../src/status.js');
    rmSync(join(repoDir, 'to-delete.txt'));

    expect(getDirtyPaths()).toEqual(['to-delete.txt']);

    git('checkout -- to-delete.txt');
  });

  it('reports both endpoints of a staged rename', async () => {
    const { getDirtyPaths } = await import('../src/status.js');
    git('mv to-rename.txt renamed.txt');

    const paths = getDirtyPaths();
    expect(paths).toContain('renamed.txt');
    expect(paths).toContain('to-rename.txt');

    git('mv renamed.txt to-rename.txt');
  });

  it('reports the files inside an untracked directory, not the collapsed directory', async () => {
    const { getDirtyPaths } = await import('../src/status.js');
    mkdirSync(join(repoDir, 'newdir'));
    writeFile(join('newdir', 'new.txt'), 'inside\n');

    // Plain porcelain collapses this to `?? newdir/`, while the working-tree diff enumerates
    // the file itself — the guard must speak the same language as the diff.
    expect(getDirtyPaths()).toEqual(['newdir/new.txt']);

    rmSync(join(repoDir, 'newdir'), { recursive: true });
  });

  it('reports a path with a space verbatim', async () => {
    const { getDirtyPaths } = await import('../src/status.js');
    writeFile('with space.txt', 'edited\n');

    expect(getDirtyPaths()).toEqual(['with space.txt']);

    git('checkout -- "with space.txt"');
  });

  it('reports a path with a newline verbatim', async () => {
    const { getDirtyPaths } = await import('../src/status.js');
    writeFile('line\nbreak.txt', 'untracked\n');

    // Without -z this entry would be quoted as "line\nbreak.txt" and split by a line parser.
    expect(getDirtyPaths()).toEqual(['line\nbreak.txt']);

    rmSync(join(repoDir, 'line\nbreak.txt'));
  });
});
