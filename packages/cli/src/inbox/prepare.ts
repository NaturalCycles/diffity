import { join } from 'node:path';
import type { PrSnapshot } from '@diffity/github';
import type { InboxConfig } from './config.js';
import { parseAgentOutput, type RunStats } from './agent-output.js';
import { inboxDir } from './paths.js';
import { composePrompt, verdictOf } from './prompt.js';
import { summarizeBundleFile } from './summary.js';
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
  /** Add to the log rather than start it over — one file for every answer on a review. */
  appendLog?: boolean;
}

export interface ExportOpts {
  worktree: string;
  prNumber: number;
  outPath: string;
}

/** The side effects the preparer needs, injected so the orchestration itself is testable. */
export interface PrepareDeps {
  startServer(worktree: string, diffRef: string): Promise<ServerHandle>;
  /** The drafting agent's command, built fresh so a settings change applies from the next prepare. */
  agentArgv(): string[];
  runAgent(opts: RunAgentOpts): Promise<{ stdout: string; timedOut: boolean }>;
  exportBundle(opts: ExportOpts): void | Promise<void>;
  now(): string;
}

export type PrepareResult =
  | { kind: 'prepared'; headSha: string; bundlePath: string; worktree: string; logPath: string; at: string; summary: string | null; alert: string | null; stats: RunStats | null }
  | { kind: 'skipped'; reason: string; logPath: string; stats: RunStats | null }
  | { kind: 'failed'; reason: string; worktree: string | null; logPath: string | null; stats: RunStats | null };

/** Where the daemon keeps what preparation produces, beside its config rather than the worktrees. */
export function bundlesDir(): string {
  return join(inboxDir(), 'bundles');
}

export function logsDir(): string {
  return join(inboxDir(), 'logs');
}

/**
 * Prepares one pull request end to end: a worktree at its head, a diffity session over it, the
 * agent's review, and — when the agent says it reviewed rather than skipped — an exported bundle.
 * The server is always stopped and, on a skip or a failure, the worktree is removed; a prepared
 * review keeps its worktree so opening it is instant.
 */
export interface PrepareOpts {
  /** The reviewer asked for this one by name, so the filter does not get a say. */
  bumped?: boolean;
}

export async function preparePr(snapshot: PrSnapshot, config: InboxConfig, deps: PrepareDeps, opts: PrepareOpts = {}): Promise<PrepareResult> {
  const dest = worktreePath(config.worktreesDir, snapshot);
  const clone = cloneDir(config.reposDir, snapshot.repo);
  const logPath = join(logsDir(), `${snapshot.owner}-${snapshot.repo}-${snapshot.number}.log`);

  let head: string;
  let diffRef: string;
  try {
    ({ head, diffRef } = await prepareWorktree(clone, dest, snapshot, snapshot.baseRef));
  } catch (err) {
    return { kind: 'failed', reason: err instanceof Error ? err.message : String(err), worktree: null, logPath: null, stats: null };
  }

  let server: ServerHandle | null = null;
  let stats: RunStats | null = null;
  try {
    server = await deps.startServer(dest, diffRef);
    const { stdout, timedOut } = await deps.runAgent({
      argv: deps.agentArgv(),
      prompt: composePrompt({
        snapshot, worktreePath: dest, port: server.port, alertWhen: config.alertWhen,
        filter: opts.bumped ? '' : config.filter, mcpAllow: config.agent.mcpAllow,
      }),
      cwd: dest,
      logPath,
      timeoutMs: config.prepareTimeoutMinutes * 60_000,
    });

    if (timedOut) {
      await removeWorktree(clone, dest);
      return { kind: 'failed', reason: `the agent did not finish within ${config.prepareTimeoutMinutes} minutes`, worktree: null, logPath, stats: null };
    }

    const parsed = parseAgentOutput(stdout);
    stats = parsed.stats;

    if (stats?.subtype === 'error_max_budget_usd') {
      await removeWorktree(clone, dest);
      return { kind: 'failed', reason: `the agent hit its budget of $${config.agent.maxBudgetUsd}`, worktree: null, logPath, stats };
    }

    const verdict = verdictOf(parsed.text);
    if (verdict.kind === 'skipped') {
      await removeWorktree(clone, dest);
      return { kind: 'skipped', reason: verdict.reason, logPath, stats };
    }
    if (verdict.kind === 'none') {
      await removeWorktree(clone, dest);
      return { kind: 'failed', reason: 'the agent ended without SKIP or PREPARED', worktree: null, logPath, stats };
    }

    // The head actually checked out, which may be newer than the snapshot if the author pushed
    // between the search and the fetch; recording it keeps the next tick from calling it stale.
    const bundlePath = join(bundlesDir(), `${snapshot.owner}-${snapshot.repo}-${snapshot.number}-${head.slice(0, 12)}.json`);
    try {
      await deps.exportBundle({ worktree: dest, prNumber: snapshot.number, outPath: bundlePath });
    } catch (err) {
      return { kind: 'failed', reason: `the review was prepared but its bundle could not be written: ${err instanceof Error ? err.message : err}`, worktree: dest, logPath, stats };
    }

    return { kind: 'prepared', headSha: head, bundlePath, worktree: dest, logPath, at: deps.now(), summary: summarizeBundleFile(bundlePath), alert: verdict.alert, stats };
  } catch (err) {
    return { kind: 'failed', reason: err instanceof Error ? err.message : String(err), worktree: dest, logPath, stats };
  } finally {
    server?.stop();
  }
}
