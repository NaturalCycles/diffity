import { spawn, execFileSync } from 'node:child_process';
import { createWriteStream, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname } from 'node:path';
import { findInstanceForRepo, killInstance, type RegistryEntry } from '../registry.js';
import type { ExportOpts, PrepareDeps, RunAgentOpts, ServerHandle } from './prepare.js';

/** How the diffity server for a worktree is found once it has started. */
function repoHash(repoRoot: string): string {
  return createHash('sha256').update(repoRoot).digest('hex').slice(0, 12);
}

/**
 * The real side effects behind `preparePr`. `entry` is this CLI's own bundle, so a prepared review
 * runs the exact diffity the daemon is part of; `nodePath` is the interpreter to run it with.
 */
export function realPrepareDeps(nodePath: string, entry: string): PrepareDeps {
  return {
    startServer: (worktree, diffRef) => startDiffityServer(nodePath, entry, worktree, diffRef),
    runAgent,
    exportBundle: opts => exportBundle(nodePath, entry, opts),
    now: () => new Date().toISOString(),
  };
}

/**
 * Starts a diffity server over the worktree, pinned to the pull request, and resolves once it has
 * registered its port. Detached so it outlives one tick — a prepared review's server stays up for
 * the reviewer to open; `stop` kills it and clears the registry entry.
 */
export function startDiffityServer(nodePath: string, entry: string, worktree: string, diffRef: string, waitMs = 30_000): Promise<ServerHandle> {
  const child = spawn(nodePath, [entry, '--repo', worktree, '--no-open', '--quiet', diffRef], {
    detached: true,
    stdio: 'ignore',
  });
  child.unref();

  const hash = repoHash(worktree);
  const deadline = Date.now() + waitMs;
  return new Promise((resolve, reject) => {
    const poll = () => {
      const entryRow: RegistryEntry | null = findInstanceForRepo(hash);
      if (entryRow) {
        resolve({ port: entryRow.port, stop: () => killInstance(entryRow) });
        return;
      }
      if (Date.now() >= deadline) {
        try { child.kill('SIGTERM'); } catch { /* already gone */ }
        reject(new Error(`diffity did not start for ${worktree} within ${waitMs / 1000}s`));
        return;
      }
      setTimeout(poll, 500);
    };
    child.on('error', err => reject(new Error(`could not start diffity: ${err.message}`)));
    setTimeout(poll, 500);
  });
}

/** Runs the review agent with the prompt on stdin, teeing its output to the log and returning it. */
export function runAgent(opts: RunAgentOpts): Promise<{ stdout: string; timedOut: boolean }> {
  mkdirSync(dirname(opts.logPath), { recursive: true });
  const log = createWriteStream(opts.logPath, { flags: 'w' });
  const [command, ...args] = opts.argv;

  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: opts.cwd, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
    }, opts.timeoutMs);

    child.stdout.on('data', chunk => { stdout += chunk; log.write(chunk); });
    child.stderr.on('data', chunk => log.write(chunk));
    child.stdin.on('error', () => { /* the agent may close stdin before we finish writing */ });
    child.stdin.end(opts.prompt);

    child.on('error', err => {
      clearTimeout(timer);
      log.end();
      reject(new Error(`could not run the prepare command "${command}": ${err.message}`));
    });
    child.on('close', () => {
      clearTimeout(timer);
      log.end();
      resolve({ stdout, timedOut });
    });
  });
}

function exportBundle(nodePath: string, entry: string, opts: ExportOpts): void {
  mkdirSync(dirname(opts.outPath), { recursive: true });
  execFileSync(
    nodePath,
    [entry, '--repo', opts.worktree, 'agent', 'export-bundle', '--pr', String(opts.prNumber), '--out', opts.outPath],
    { stdio: 'pipe' },
  );
}
