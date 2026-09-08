import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { prepareWorktree, removeWorktree } from '../src/inbox/worktree.js';

let root: string;
let upstream: string;
let clone: string;
let dest: string;
let head: string;
const ref = { owner: 'o', repo: 'demo', number: 4 };

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, stdio: 'pipe', encoding: 'utf-8' }).trim();
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'diffity-worktree-'));
  upstream = join(root, 'remotes', 'o', 'demo');
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

  it('cuts two pull requests at once from one clone, each at its own head and base', async () => {
    // A second pull request on a base branch of its own, whose name carries a slash.
    git(upstream, ['checkout', '-q', '-b', 'release/1.x']);
    writeFileSync(join(upstream, 'base.ts'), 'const base = 1;\n');
    git(upstream, ['add', '.']);
    git(upstream, ['commit', '-m', 'the other base']);
    const otherBase = git(upstream, ['rev-parse', 'HEAD']);
    // The pull request's own commit on top of that base, off the branch, as a fork's push looks.
    git(upstream, ['checkout', '-q', '--detach']);
    writeFileSync(join(upstream, 'five.ts'), 'const five = 5;\n');
    git(upstream, ['add', '.']);
    git(upstream, ['commit', '-m', 'the other change']);
    git(upstream, ['update-ref', 'refs/pull/5/head', 'HEAD']);
    const otherHead = git(upstream, ['rev-parse', 'HEAD']);
    git(upstream, ['checkout', '-q', 'main']);
    const main = git(upstream, ['rev-parse', 'main']);
    const otherRef = { owner: 'o', repo: 'demo', number: 5 };
    const otherDest = join(root, 'worktrees', 'o-demo-5');

    const [four, five] = await Promise.all([
      prepareWorktree(clone, dest, ref, 'main'),
      prepareWorktree(clone, otherDest, otherRef, 'release/1.x'),
    ]);

    // Neither fetch was read back off the other's: each cut is at its own head, against its own base.
    expect(four).toEqual({ head, diffRef: main });
    expect(five).toEqual({ head: otherHead, diffRef: otherBase });
    expect(git(dest, ['rev-parse', 'HEAD'])).toBe(head);
    expect(git(otherDest, ['rev-parse', 'HEAD'])).toBe(otherHead);
    expect(existsSync(join(dest, 'five.ts'))).toBe(false);
    expect(existsSync(join(otherDest, 'five.ts'))).toBe(true);
  });

  describe('with a pinned head', () => {
    /** A second push on the pull request, leaving the head captured in `head` behind. */
    function pushOnTop(): string {
      writeFileSync(join(upstream, 'b.ts'), 'const b = 2;\n');
      git(upstream, ['add', '.']);
      git(upstream, ['commit', '-m', 'more']);
      git(upstream, ['update-ref', `refs/pull/${ref.number}/head`, 'HEAD']);
      return git(upstream, ['rev-parse', 'HEAD']);
    }

    it('cuts the worktree at an earlier head the pull request has moved past', async () => {
      const moved = pushOnTop();

      const cut = await prepareWorktree(clone, dest, ref, 'main', head);

      expect(cut.head).toBe(head);
      expect(git(dest, ['rev-parse', 'HEAD'])).toBe(head);
      // The later commit's file is not in the tree, so the review is about the pinned code.
      expect(existsSync(join(dest, 'b.ts'))).toBe(false);
      expect(moved).not.toBe(head);
    });

    it('takes the pull request as it stands when nothing is pinned', async () => {
      const moved = pushOnTop();

      const cut = await prepareWorktree(clone, dest, ref, 'main');

      expect(cut.head).toBe(moved);
      expect(existsSync(join(dest, 'b.ts'))).toBe(true);
    });

    it('asks origin by sha for a pinned commit the clone has never fetched', async () => {
      // What GitHub allows: any commit reachable from a ref it advertises can be asked for by sha.
      git(upstream, ['config', 'uploadpack.allowReachableSHA1InWant', 'true']);
      // On a branch of its own, made after the clone, so no fetch of main or the pull ref brings it.
      git(upstream, ['checkout', '-q', '-b', 'other']);
      writeFileSync(join(upstream, 'c.ts'), 'const c = 3;\n');
      git(upstream, ['add', '.']);
      git(upstream, ['commit', '-m', 'elsewhere']);
      const elsewhere = git(upstream, ['rev-parse', 'HEAD']);
      expect(() => git(clone, ['cat-file', '-e', `${elsewhere}^{commit}`])).toThrow();

      const cut = await prepareWorktree(clone, dest, ref, 'main', elsewhere);

      expect(cut.head).toBe(elsewhere);
      expect(existsSync(join(dest, 'c.ts'))).toBe(true);
    });

    it('says so when the pinned head is gone from origin', async () => {
      const forcePushedAway = 'deadbeef'.repeat(5);

      await expect(prepareWorktree(clone, dest, ref, 'main', forcePushedAway))
        .rejects.toThrow(/the baseline's head deadbeefdead is no longer reachable from origin \(force-pushed\?\)/);
      expect(existsSync(dest)).toBe(false);
    });
  });
});

describe('removeWorktree', () => {
  it('refuses to delete a repository of its own, or the clone', async () => {
    const repo = join(root, 'worktrees', 'somebody-elses-repo');
    execFileSync('git', ['init', '-q', repo], { stdio: 'pipe' });
    writeFileSync(join(repo, 'precious.txt'), 'keep\n');
    await expect(removeWorktree(clone, repo)).rejects.toThrow(/refusing to delete/);
    expect(existsSync(join(repo, 'precious.txt'))).toBe(true);

    await expect(removeWorktree(clone, clone)).rejects.toThrow(/refusing to delete/);
    expect(existsSync(join(clone, 'a.ts'))).toBe(true);
  });

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
