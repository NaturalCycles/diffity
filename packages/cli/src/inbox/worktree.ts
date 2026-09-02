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
 * and the base branch first, and returns the head it actually checked out together with the ref to
 * diff against — the fetched base, so a diffity session over the worktree shows the same change as
 * the pull request without asking the forge anything. Idempotent and self-healing: an existing
 * worktree, even one a killed agent left dirty, is forced to the new head rather than re-created.
 */
export function prepareWorktree(clone: string, dest: string, ref: PrRef, baseRef: string): { head: string; diffRef: string } {
  if (!existsSync(clone)) {
    throw new Error(`No local clone at ${clone}. Clone ${ref.owner}/${ref.repo} there first.`);
  }
  if (!baseRef) {
    throw new Error(`No base branch for ${ref.owner}/${ref.repo}#${ref.number}; cannot tell what the change is against.`);
  }
  requireMatchingOrigin(clone, ref);

  runGit(clone, ['fetch', 'origin', `refs/pull/${ref.number}/head`]);
  const head = revParse(clone, 'FETCH_HEAD');
  // `refs/heads/` so a tag sharing the branch's name cannot be fetched in its place.
  runGit(clone, ['fetch', 'origin', `refs/heads/${baseRef}`]);
  const diffRef = revParse(clone, 'FETCH_HEAD');

  if (existsSync(join(dest, '.git'))) {
    runGit(dest, ['checkout', '--detach', '--force', head]);
  } else {
    try {
      runGit(clone, ['worktree', 'add', '--detach', '--force', dest, head]);
    } catch (err) {
      // A directory git no longer tracks (after `worktree prune`) blocks `add`; clear and retry.
      removeWorktree(clone, dest);
      runGit(clone, ['worktree', 'add', '--detach', '--force', dest, head]);
      if (!existsSync(join(dest, '.git'))) {
        throw err;
      }
    }
  }
  return { head, diffRef };
}

function revParse(cwd: string, ref: string): string {
  return execFileSync('git', ['rev-parse', ref], { cwd, encoding: 'utf-8' }).trim();
}

/** The clone must actually be the pull request's repository, not another of the same name. */
function requireMatchingOrigin(clone: string, ref: PrRef): void {
  let url: string;
  try {
    url = execFileSync('git', ['remote', 'get-url', 'origin'], { cwd: clone, encoding: 'utf-8' }).trim();
  } catch {
    throw new Error(`${clone} has no origin remote; cannot confirm it is ${ref.owner}/${ref.repo}.`);
  }
  const want = `${ref.owner}/${ref.repo}`.toLowerCase();
  const normalized = url.toLowerCase().replace(/\.git$/, '');
  if (!normalized.endsWith(`/${want}`) && !normalized.endsWith(`:${want}`)) {
    throw new Error(`${clone} is ${url}, not ${ref.owner}/${ref.repo}.`);
  }
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
