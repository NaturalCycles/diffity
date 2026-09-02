import { join } from 'node:path';
import type { PrSnapshot } from '@diffity/github';
import type { InboxConfig } from './config.js';
import { composePrompt, verdictOf } from './prompt.js';
import { cloneDir, prepareWorktree, removeWorktree, worktreePath } from './worktree.js';

/** A running diffity server for a worktree, and the way to stop it again. */
export interface ServerHandle {
  port: number;
  stop(): void;
}

export interface RunAgentOpts {
  argv: string[];
  prompt: string;
  cwd: string;
  logPath: string;
  timeoutMs: number;
}

export interface ExportOpts {
  worktree: string;
  prNumber: number;
  outPath: string;
}

/** The side effects the preparer needs, injected so the orchestration itself is testable. */
export interface PrepareDeps {
  startServer(worktree: string, diffRef: string): Promise<ServerHandle>;
  runAgent(opts: RunAgentOpts): Promise<{ stdout: string; timedOut: boolean }>;
  exportBundle(opts: ExportOpts): void;
  now(): string;
}

export type PrepareResult =
  | { kind: 'prepared'; headSha: string; bundlePath: string; worktree: string; logPath: string; at: string }
  | { kind: 'skipped'; reason: string; worktree: string; logPath: string }
  | { kind: 'failed'; reason: string; worktree: string | null; logPath: string | null };

/** Where the daemon keeps what preparation produces, apart from the worktrees. */
export function bundlesDir(worktreesDir: string): string {
  return join(worktreesDir, '..', 'bundles');
}

export function logsDir(worktreesDir: string): string {
  return join(worktreesDir, '..', 'logs');
}

/**
 * Prepares one pull request end to end: a worktree at its head, a diffity session over it, the
 * agent's review, and — when the agent says it reviewed rather than skipped — an exported bundle.
 * The server is always stopped and, on a skip or a failure, the worktree is removed; a prepared
 * review keeps its worktree so opening it is instant.
 */
export async function preparePr(snapshot: PrSnapshot, config: InboxConfig, deps: PrepareDeps): Promise<PrepareResult> {
  const dest = worktreePath(config.worktreesDir, snapshot);
  const clone = cloneDir(config.reposDir, snapshot.repo);
  const logPath = join(logsDir(config.worktreesDir), `${snapshot.owner}-${snapshot.repo}-${snapshot.number}.log`);

  let diffRef: string;
  try {
    ({ diffRef } = prepareWorktree(clone, dest, snapshot, snapshot.baseRef));
  } catch (err) {
    return { kind: 'failed', reason: err instanceof Error ? err.message : String(err), worktree: null, logPath: null };
  }

  let server: ServerHandle | null = null;
  try {
    server = await deps.startServer(dest, diffRef);
    const { stdout, timedOut } = await deps.runAgent({
      argv: config.prepare,
      prompt: composePrompt({ snapshot, worktreePath: dest, port: server.port, filter: config.filter }),
      cwd: dest,
      logPath,
      timeoutMs: config.prepareTimeoutMinutes * 60_000,
    });

    if (timedOut) {
      removeWorktree(clone, dest);
      return { kind: 'failed', reason: `the agent did not finish within ${config.prepareTimeoutMinutes} minutes`, worktree: null, logPath };
    }

    const verdict = verdictOf(stdout);
    if (verdict.kind === 'skipped') {
      removeWorktree(clone, dest);
      return { kind: 'skipped', reason: verdict.reason, worktree: dest, logPath };
    }
    if (verdict.kind === 'none') {
      removeWorktree(clone, dest);
      return { kind: 'failed', reason: 'the agent ended without SKIP or PREPARED', worktree: null, logPath };
    }

    const bundlePath = join(bundlesDir(config.worktreesDir), `${snapshot.owner}-${snapshot.repo}-${snapshot.number}-${snapshot.headSha.slice(0, 12)}.json`);
    try {
      deps.exportBundle({ worktree: dest, prNumber: snapshot.number, outPath: bundlePath });
    } catch (err) {
      return { kind: 'failed', reason: `the review was prepared but its bundle could not be written: ${err instanceof Error ? err.message : err}`, worktree: dest, logPath };
    }

    return { kind: 'prepared', headSha: snapshot.headSha, bundlePath, worktree: dest, logPath, at: deps.now() };
  } catch (err) {
    return { kind: 'failed', reason: err instanceof Error ? err.message : String(err), worktree: dest, logPath };
  } finally {
    server?.stop();
  }
}
