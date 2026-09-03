import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFileSync, realpathSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { checkInstanceHealth, findInstanceForRepo } from '../registry.js';

/**
 * Brings a prepared review up as a live diffity session the reviewer can open: a server over the
 * worktree, diffing against the pull request's base and told which pull request it shows, with the
 * prepared findings imported. Returns the URL to send the browser to. Import failure is not fatal —
 * the diff is still worth opening — but it is surfaced to the caller.
 */
export async function openPreparedSession(worktree: string, bundlePath: string, prNumber: number, deps: OpenSessionDeps): Promise<OpenedSession> {
  const ref = deps.baseRefOf(bundlePath);
  const port = await deps.ensureServer(worktree, ref, prNumber);
  const url = sessionUrl(port, ref);
  try {
    await deps.importBundle(worktree, bundlePath);
  } catch (err) {
    return { url, imported: false, importError: err instanceof Error ? err.message : String(err) };
  }
  return { url, imported: true };
}

/**
 * The diff page at the session's ref. The bare root redirects to the working-tree diff, which is
 * empty for a clean worktree at the pull request's head.
 */
function sessionUrl(port: number, ref: string): string {
  return `http://localhost:${port}/diff?ref=${encodeURIComponent(ref)}`;
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
    ensureServer: (worktree, ref, prNumber) => ensureServer(nodePath, entry, worktree, ref, prNumber),
    importBundle: async (worktree, bundlePath) => {
      await promisify(execFile)(nodePath, [entry, '--repo', worktree, 'agent', 'import-bundle', bundlePath]);
    },
  };
}

export async function ensureServer(nodePath: string, entry: string, worktree: string, ref: string, prNumber: number | undefined, waitMs = 30_000): Promise<number> {
  const hash = repoHash(worktree);
  // A healthy server already on this worktree is reused as-is. The worktree lives under the inbox's
  // own directory and is only ever served at the pull request's base, so its ref is the one wanted.
  const existing = findInstanceForRepo(hash);
  if (existing && await checkInstanceHealth(existing.port)) {
    return existing.port;
  }

  const child = spawn(nodePath, serverArgs(entry, worktree, ref, prNumber), { detached: true, stdio: 'ignore' });
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

/**
 * The argv that brings a worktree up as a session at the ref. A detached worktree cannot name its
 * pull request, so the number goes along: it is what puts the description, the reviews and the
 * submit dialog on the page.
 */
export function serverArgs(entry: string, worktree: string, ref: string, prNumber: number | undefined): string[] {
  return [entry, '--repo', worktree, '--no-open', '--quiet', ...(prNumber !== undefined ? ['--pr', String(prNumber)] : []), ref];
}

/** The server registers under the hash of its resolved repo root, so resolve symlinks before hashing. */
export function repoHash(worktree: string): string {
  let root = worktree;
  try { root = realpathSync(worktree); } catch { /* not yet on disk; hash the path as given */ }
  return createHash('sha256').update(root).digest('hex').slice(0, 12);
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export interface OpenSessionDeps {
  /** Reads the base ref recorded in the bundle, so the session diffs the same change. */
  baseRefOf(bundlePath: string): string;
  /** Ensures a diffity server for the worktree at that ref, told its pull request, and returns its port. */
  ensureServer(worktree: string, ref: string, prNumber: number): Promise<number>;
  /** Adds the prepared review's threads and tours to the running session. */
  importBundle(worktree: string, bundlePath: string): void | Promise<void>;
}

export interface OpenedSession {
  url: string;
  imported: boolean;
  /** Why the import did not happen, when it didn't; the diff is still opened. */
  importError?: string;
}
