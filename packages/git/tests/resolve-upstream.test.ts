import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

let root: string;
let repoDir: string;
let origCwd: string;

function git(args: string[], cwd = repoDir): string {
  return execFileSync('git', args, { cwd, encoding: 'utf-8', stdio: 'pipe' }).trim();
}

function commit(name: string, content: string): void {
  writeFileSync(join(repoDir, name), content);
  git(['add', '.']);
  git(['commit', '-m', `add ${content}`]);
}

beforeAll(() => {
  origCwd = process.cwd();
  root = mkdtempSync(join(tmpdir(), 'diffity-upstream-'));
  repoDir = join(root, 'repo');
  const remoteDir = join(root, 'remote.git');

  execFileSync('git', ['init', '--bare', remoteDir], { stdio: 'pipe' });
  execFileSync('git', ['init', '-b', 'main', repoDir], { stdio: 'pipe' });
  git(['config', 'user.email', 'test@test.com']);
  git(['config', 'user.name', 'Test']);

  commit('a.txt', 'a');
  git(['remote', 'add', 'origin', remoteDir]);
  git(['push', '-u', 'origin', 'main']);

  // The remote moves on, and a feature branch is cut from that newer main...
  commit('b.txt', 'b');
  git(['push', 'origin', 'main']);
  git(['checkout', '-b', 'feature']);
  commit('c.txt', 'c');

  // ...while the local main is left where it was, two commits behind.
  git(['checkout', 'main']);
  git(['reset', '--hard', 'HEAD~1']);
  git(['checkout', 'feature']);

  process.chdir(repoDir);
});

afterAll(() => {
  process.chdir(origCwd);
  rmSync(root, { recursive: true, force: true });
});

describe('resolveThroughUpstream', () => {
  it('redirects a local branch that is behind its upstream', async () => {
    const { resolveThroughUpstream } = await import('../src/diff.js');

    expect(resolveThroughUpstream('main')).toBe('origin/main');
  });

  it('leaves a branch that is level with its upstream alone', async () => {
    const { resolveThroughUpstream } = await import('../src/diff.js');
    git(['checkout', 'main']);
    git(['pull', '--ff-only']);
    git(['checkout', 'feature']);

    expect(resolveThroughUpstream('main')).toBe('main');
  });

  it('leaves a branch with no upstream alone', async () => {
    const { resolveThroughUpstream } = await import('../src/diff.js');

    expect(resolveThroughUpstream('feature')).toBe('feature');
  });

  it('leaves a commit alone', async () => {
    const { resolveThroughUpstream } = await import('../src/diff.js');
    const sha = git(['rev-parse', 'HEAD']);

    expect(resolveThroughUpstream(sha)).toBe(sha);
  });
});

describe('normalizeRef', () => {
  it('bases the diff on the upstream when the local branch is stale', async () => {
    const { normalizeRef } = await import('../src/diff.js');
    git(['checkout', 'main']);
    git(['reset', '--hard', 'HEAD~1']);
    git(['checkout', 'feature']);

    const expected = git(['merge-base', 'origin/main', 'HEAD']);

    expect(normalizeRef('main')).toBe(expected);
    expect(normalizeRef('main')).not.toBe(git(['merge-base', 'main', 'HEAD']));
  });
});
