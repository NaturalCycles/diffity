import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { PrRef } from '@diffity/github';

const execFileAsync = promisify(execFile);

/** The base clone a pull request's worktree is cut from — one directory per repository name. */
export function cloneDir(reposDir: string, repo: string): string {
  return join(reposDir, repo);
}

export function worktreePath(worktreesDir: string, ref: PrRef): string {
  return join(worktreesDir, `${ref.owner}-${ref.repo}-${ref.number}`);
}

/**
 * Off the event loop on purpose: a fetch or a worktree add on a large clone takes as long as it
 * takes, and the daemon's own server has to keep answering the inbox page and its opens meanwhile.
 */
async function runGit(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', args, { cwd, encoding: 'utf-8', maxBuffer: 16 * 1024 * 1024 });
  return stdout.trim();
}

/**
 * Cuts a detached worktree at the pull request's head from the base clone, fetching both the head
 * and the base branch first, and returns the head it actually checked out together with the ref to
 * diff against — the fetched base, so a diffity session over the worktree shows the same change as
 * the pull request without asking the forge anything. Idempotent and self-healing: an existing
 * worktree, even one a killed agent left dirty, is forced to the new head rather than re-created.
 */
export async function prepareWorktree(clone: string, dest: string, ref: PrRef, baseRef: string): Promise<{ head: string; diffRef: string }> {
  if (!existsSync(clone)) {
    throw new Error(`No local clone at ${clone}. Clone ${ref.owner}/${ref.repo} there first.`);
  }
  if (!baseRef) {
    throw new Error(`No base branch for ${ref.owner}/${ref.repo}#${ref.number}; cannot tell what the change is against.`);
  }
  await requireMatchingOrigin(clone, ref);

  await runGit(clone, ['fetch', 'origin', `refs/pull/${ref.number}/head`]);
  const head = await runGit(clone, ['rev-parse', 'FETCH_HEAD']);
  // `refs/heads/` so a tag sharing the branch's name cannot be fetched in its place.
  await runGit(clone, ['fetch', 'origin', `refs/heads/${baseRef}`]);
  const diffRef = await runGit(clone, ['rev-parse', 'FETCH_HEAD']);

  if (existsSync(join(dest, '.git'))) {
    await runGit(dest, ['checkout', '--detach', '--force', head]);
  } else {
    try {
      await runGit(clone, ['worktree', 'add', '--detach', '--force', dest, head]);
    } catch (err) {
      // A directory git no longer tracks (after `worktree prune`) blocks `add`; clear and retry.
      await removeWorktree(clone, dest);
      await runGit(clone, ['worktree', 'add', '--detach', '--force', dest, head]);
      if (!existsSync(join(dest, '.git'))) {
        throw err;
      }
    }
  }
  return { head, diffRef };
}

/** The clone must actually be the pull request's repository, not another of the same name. */
async function requireMatchingOrigin(clone: string, ref: PrRef): Promise<void> {
  let url: string;
  try {
    url = await runGit(clone, ['remote', 'get-url', 'origin']);
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
export async function removeWorktree(clone: string, dest: string): Promise<void> {
  if (!existsSync(clone) || !existsSync(dest)) {
    return;
  }
  try {
    await runGit(clone, ['worktree', 'remove', '--force', dest]);
  } catch {
    // A worktree git no longer tracks is already as gone as this needs it to be.
  }
}
