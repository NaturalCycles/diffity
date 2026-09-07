import { execFile } from 'node:child_process';
import { existsSync, realpathSync, statSync } from 'node:fs';
import { rm } from 'node:fs/promises';
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
 *
 * Hooks off. A checkout's hook scripts are the pull request author's code, and this process holds
 * the reviewer's credentials — the opposite of the stripped environment the agent gets. They also
 * turned every worktree add into an install and a build. Git looks for hooks in the named
 * directory; a path that is not one has none.
 */
async function runGit(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', ['-c', 'core.hooksPath=/dev/null', ...args], {
    cwd, encoding: 'utf-8', maxBuffer: 16 * 1024 * 1024, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
  });
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
    try {
      await runGit(dest, ['checkout', '--detach', '--force', head]);
      return { head, diffRef };
    } catch {
      // A directory whose registration in the clone is gone is not a worktree any more, whatever
      // its .git file says; it is cleared and cut again below.
      await removeWorktree(clone, dest);
    }
  }
  try {
    await runGit(clone, ['worktree', 'add', '--detach', '--force', dest, head]);
  } catch (err) {
    // A leftover directory blocks `add`; clear it and retry once.
    await removeWorktree(clone, dest);
    await runGit(clone, ['worktree', 'add', '--detach', '--force', dest, head]);
    if (!existsSync(join(dest, '.git'))) {
      throw err;
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

/**
 * Only what a linked worktree or its debris can be is deleted: a directory whose `.git` is a file
 * (the pointer a linked worktree carries) or absent. A `.git` directory is a repository in its own
 * right — the clone, or something a misconfigured worktreesDir points at — and is never touched.
 */
function isDisposable(clone: string, dest: string): boolean {
  try {
    if (existsSync(clone) && realpathSync(clone) === realpathSync(dest)) {
      return false;
    }
    const gitEntry = join(dest, '.git');
    return !existsSync(gitEntry) || statSync(gitEntry).isFile();
  } catch {
    return false;
  }
}

/**
 * Removes the worktree, forcing past a dirty tree — a prepared review leaves none, but a killed agent
 * might. The directory is the daemon's own, so it goes whatever git made of it: one git no longer
 * tracks, or never finished cutting, is deleted outright, and a registration git may still hold for
 * the path is pruned so the path can be cut again.
 */
export async function removeWorktree(clone: string, dest: string): Promise<void> {
  if (!existsSync(dest)) {
    return;
  }
  if (!isDisposable(clone, dest)) {
    throw new Error(`${dest} is a repository of its own, not a worktree cut by the inbox; refusing to delete it.`);
  }
  if (existsSync(clone)) {
    try {
      await runGit(clone, ['worktree', 'remove', '--force', dest]);
    } catch {
      // Not a worktree git knows; the directory is dealt with below.
    }
  }
  await rm(dest, { recursive: true, force: true });
  if (existsSync(clone)) {
    try {
      await runGit(clone, ['worktree', 'prune']);
    } catch {
      // Nothing to prune is not a failure.
    }
  }
}
