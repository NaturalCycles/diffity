import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { prepareWorktree, removeWorktree } from '../src/inbox/worktree.js';

let root: string;
let clone: string;
let dest: string;
let head: string;
const ref = { owner: 'o', repo: 'demo', number: 4 };

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, stdio: 'pipe', encoding: 'utf-8' }).trim();
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'diffity-worktree-'));
  const upstream = join(root, 'remotes', 'o', 'demo');
  execFileSync('git', ['init', '-b', 'main', upstream], { stdio: 'pipe' });
  git(upstream, ['config', 'user.email', 't@t']);
  git(upstream, ['config', 'user.name', 'T']);
  writeFileSync(join(upstream, 'a.ts'), 'const a = 1;\n');
  git(upstream, ['add', '.']);
  git(upstream, ['commit', '-m', 'init']);
  git(upstream, ['update-ref', 'refs/pull/4/head', 'HEAD']);
  head = git(upstream, ['rev-parse', 'HEAD']);
  clone = join(root, 'repos', 'demo');
  execFileSync('git', ['clone', '--quiet', upstream, clone], { stdio: 'pipe' });
  dest = join(root, 'worktrees', 'o-demo-4');
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('prepareWorktree', () => {
  it('runs none of the checkout\'s hooks, which are the author\'s code', async () => {
    // A hook that would leave a mark, wired the way husky wires them: core.hooksPath in the clone.
    const hooks = join(root, 'hooks');
    mkdirSync(hooks);
    const marker = join(root, 'hook-ran');
    writeFileSync(join(hooks, 'post-checkout'), `#!/bin/sh\ntouch "${marker}"\n`);
    chmodSync(join(hooks, 'post-checkout'), 0o755);
    git(clone, ['config', 'core.hooksPath', hooks]);
    // The wiring works: a plain checkout in the clone runs it.
    git(clone, ['checkout', '--detach', 'HEAD']);
    expect(existsSync(marker)).toBe(true);
    rmSync(marker);

    const cut = await prepareWorktree(clone, dest, ref, 'main');
    expect(cut.head).toBe(head);
    expect(git(dest, ['rev-parse', 'HEAD'])).toBe(head);
    expect(existsSync(marker)).toBe(false);

    // And not on the re-checkout of an existing worktree either.
    await prepareWorktree(clone, dest, ref, 'main');
    expect(existsSync(marker)).toBe(false);
  });

  it('cuts the worktree again when its registration in the clone is gone', async () => {
    await prepareWorktree(clone, dest, ref, 'main');
    // What a prune, or a clone moved out from under it, leaves: a directory with a .git file that
    // points at a registration the clone no longer has.
    rmSync(join(clone, '.git', 'worktrees', 'o-demo-4'), { recursive: true, force: true });
    expect(() => git(dest, ['rev-parse', 'HEAD'])).toThrow();

    const cut = await prepareWorktree(clone, dest, ref, 'main');
    expect(cut.head).toBe(head);
    expect(git(dest, ['rev-parse', 'HEAD'])).toBe(head);
  });

  it('replaces a leftover directory that is not a worktree', async () => {
    mkdirSync(dest, { recursive: true });
    writeFileSync(join(dest, 'debris.txt'), 'left behind\n');

    const cut = await prepareWorktree(clone, dest, ref, 'main');
    expect(cut.head).toBe(head);
    expect(existsSync(join(dest, 'debris.txt'))).toBe(false);
    expect(git(dest, ['rev-parse', 'HEAD'])).toBe(head);
  });
});

describe('removeWorktree', () => {
  it('removes a worktree git knows, and a directory it does not', async () => {
    await prepareWorktree(clone, dest, ref, 'main');
    await removeWorktree(clone, dest);
    expect(existsSync(dest)).toBe(false);
    expect(git(clone, ['worktree', 'list'])).not.toContain('o-demo-4');

    mkdirSync(dest, { recursive: true });
    writeFileSync(join(dest, '.git'), `gitdir: ${join(clone, '.git', 'worktrees', 'o-demo-4')}\n`);
    await removeWorktree(clone, dest);
    expect(existsSync(dest)).toBe(false);
  });
});
