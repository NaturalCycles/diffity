import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { PrRef } from '@diffity/github';

/** The base clone a pull request's worktree is cut from — one directory per repository name. */
export function cloneDir(reposDir: string, repo: string): string {
  return join(reposDir, repo);
}

export function worktreePath(worktreesDir: string, ref: PrRef): string {
  return join(worktreesDir, `${ref.owner}-${ref.repo}-${ref.number}`);
}

function runGit(cwd: string, args: string[]): void {
  execFileSync('git', args, { cwd, stdio: 'pipe' });
}

/**
 * Cuts a detached worktree at the pull request's head from the base clone, fetching both the head
 * and the base branch first, and returns the ref to diff the review against — the fetched base, so
 * a diffity session over the worktree shows the same change as the pull request without asking the
 * forge anything. Idempotent: an existing worktree for the same pull request is moved to the new
 * head rather than re-created.
 */
export function prepareWorktree(clone: string, dest: string, ref: PrRef, baseRef: string): { diffRef: string } {
  if (!existsSync(clone)) {
    throw new Error(`No local clone at ${clone}. Clone ${ref.owner}/${ref.repo} there first.`);
  }
  runGit(clone, ['fetch', 'origin', `refs/pull/${ref.number}/head`]);
  const head = execFileSync('git', ['rev-parse', 'FETCH_HEAD'], { cwd: clone, encoding: 'utf-8' }).trim();

  let diffRef = `${head}^`;
  if (baseRef) {
    runGit(clone, ['fetch', 'origin', baseRef]);
    diffRef = execFileSync('git', ['rev-parse', 'FETCH_HEAD'], { cwd: clone, encoding: 'utf-8' }).trim();
  }

  if (existsSync(join(dest, '.git'))) {
    runGit(dest, ['checkout', '--detach', head]);
  } else {
    runGit(clone, ['worktree', 'add', '--detach', dest, head]);
  }
  return { diffRef };
}

/** Removes the worktree, forcing past a dirty tree — a prepared review leaves none, but a killed agent might. */
export function removeWorktree(clone: string, dest: string): void {
  if (!existsSync(clone) || !existsSync(dest)) {
    return;
  }
  try {
    runGit(clone, ['worktree', 'remove', '--force', dest]);
  } catch {
    // A worktree git no longer tracks is already as gone as this needs it to be.
  }
}
