import { spawn, execFileSync } from 'node:child_process';
import { readFileSync, realpathSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { checkInstanceHealth, findInstanceForRepo } from '../registry.js';

export interface OpenSessionDeps {
  /** Reads the base ref recorded in the bundle, so the session diffs the same change. */
  baseRefOf(bundlePath: string): string;
  /** Ensures a diffity server for the worktree at that ref and returns its port. */
  ensureServer(worktree: string, ref: string): Promise<number>;
  /** Adds the prepared review's threads and tours to the running session. */
  importBundle(worktree: string, bundlePath: string): void;
}

/**
 * Brings a prepared review up as a live diffity session the reviewer can open: a server over the
 * worktree, diffing against the pull request's base, with the prepared findings imported. Returns
 * the URL to send the browser to. Import failure is not fatal — the diff is still worth opening —
 * but it is surfaced to the caller.
 */
export async function openPreparedSession(worktree: string, bundlePath: string, deps: OpenSessionDeps): Promise<{ url: string; imported: boolean }> {
  const ref = deps.baseRefOf(bundlePath);
  const port = await deps.ensureServer(worktree, ref);
  let imported = true;
  try {
    deps.importBundle(worktree, bundlePath);
  } catch {
    imported = false;
  }
  return { url: `http://localhost:${port}/`, imported };
}

/** The base commit a bundle was built against; the session diffs the worktree against it. */
export function baseRefOf(bundlePath: string): string {
  const bundle = JSON.parse(readFileSync(bundlePath, 'utf-8')) as { baseSha?: string | null };
  if (!bundle.baseSha) {
    throw new Error(`The bundle at ${bundlePath} records no base commit.`);
  }
  return bundle.baseSha;
}

/**
 * The real `ensureServer`: a healthy diffity already serving this worktree is reused, otherwise one
 * is started in the reviewer's own diffity (no data-dir override), so it shows up in `diffity list`
 * and behaves like any session they opened themselves.
 */
export function realOpenSessionDeps(nodePath: string, entry: string): OpenSessionDeps {
  return {
    baseRefOf,
    ensureServer: (worktree, ref) => ensureServer(nodePath, entry, worktree, ref),
    importBundle: (worktree, bundlePath) => {
      execFileSync(nodePath, [entry, '--repo', worktree, 'agent', 'import-bundle', bundlePath], { stdio: 'pipe' });
    },
  };
}

async function ensureServer(nodePath: string, entry: string, worktree: string, ref: string, waitMs = 30_000): Promise<number> {
  const hash = repoHash(worktree);
  const existing = findInstanceForRepo(hash);
  if (existing && await checkInstanceHealth(existing.port)) {
    return existing.port;
  }

  const child = spawn(nodePath, [entry, '--repo', worktree, '--no-open', '--quiet', ref], { detached: true, stdio: 'ignore' });
  child.unref();

  const deadline = Date.now() + waitMs;
  while (Date.now() < deadline) {
    await sleep(400);
    const entryRow = findInstanceForRepo(hash);
    if (entryRow && await checkInstanceHealth(entryRow.port)) {
      return entryRow.port;
    }
  }
  try { if (child.pid) process.kill(child.pid, 'SIGTERM'); } catch { /* already gone */ }
  throw new Error(`diffity did not start for ${worktree} within ${waitMs / 1000}s`);
}

/** The server registers under the hash of its resolved repo root, so resolve symlinks before hashing. */
function repoHash(worktree: string): string {
  let root = worktree;
  try { root = realpathSync(worktree); } catch { /* not yet on disk; hash the path as given */ }
  return createHash('sha256').update(root).digest('hex').slice(0, 12);
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
