import { join } from 'node:path';
import type { PrSnapshot } from '@diffity/github';
import type { InboxConfig } from './config.js';
import { parseAgentOutput, rateLimitOf, type RunStats } from './agent-output.js';
import { inboxDir } from './paths.js';
import { localHhMm } from './runs.js';
import { composePrompt, verdictOf } from './prompt.js';
import { summarizeBundleFile } from './summary.js';
import { composeValidatePrompt, generalCommentIdOf, threadsToValidate, validateVerdictOf, type ReviewThread } from './validate.js';
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
  /** The checking agent's command: the same one with the validate model and budget. */
  validateArgv(): string[];
  runAgent(opts: RunAgentOpts): Promise<{ stdout: string; timedOut: boolean }>;
  /** The threads the drafting agent left in the session over this worktree. */
  listThreads(worktree: string): Promise<ReviewThread[]>;
  exportBundle(opts: ExportOpts): void | Promise<void>;
  now(): string;
}

/**
 * What a failed preparation failed at. `worktree` is the one that happened before any agent ran;
 * `rate-limit` is the one that is not the pull request's fault and is waited out rather than retried.
 */
export type PrepareFailure = 'worktree' | 'timeout' | 'budget' | 'rate-limit' | 'agent' | 'bundle';

/** When the agent ran and what it reported, on every outcome, so the run log has it either way. */
export interface RunLog {
  startedAt: string;
  endedAt: string;
  stats: RunStats | null;
}

/**
 * Whether the drafted findings were checked by a second pass: `not-needed` when none of them was a
 * P1 or P2, or the pass is off; `unchecked` when the pass was due but did not finish.
 */
export type Validation = 'validated' | 'unchecked' | 'not-needed';

/** The checking pass's run and what it came to; whatever that is, the draft is kept. */
export interface ValidateRun extends RunLog {
  outcome: 'validated' | 'timeout' | 'failed';
  /** Why the findings went unchecked, when they did. */
  note: string | null;
}

export type PrepareResult =
  | { kind: 'prepared'; headSha: string; bundlePath: string; worktree: string; logPath: string; at: string; summary: string | null; alert: string | null; run: RunLog; validation: Validation; validateRun: ValidateRun | null }
  | { kind: 'skipped'; reason: string; logPath: string; run: RunLog }
  | { kind: 'failed'; reason: string; failure: PrepareFailure; worktree: string | null; logPath: string | null; run: RunLog; resetsAt?: string | null };

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

  const before = deps.now();
  let run: RunLog = { startedAt: before, endedAt: before, stats: null };

  let head: string;
  let diffRef: string;
  try {
    ({ head, diffRef } = await prepareWorktree(clone, dest, snapshot, snapshot.baseRef));
  } catch (err) {
    return { kind: 'failed', failure: 'worktree', reason: err instanceof Error ? err.message : String(err), worktree: null, logPath: null, run };
  }

  let server: ServerHandle | null = null;
  try {
    server = await deps.startServer(dest, diffRef);
    const startedAt = deps.now();
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

    run = { startedAt, endedAt: deps.now(), stats: null };

    if (timedOut) {
      await removeWorktree(clone, dest);
      return { kind: 'failed', failure: 'timeout', reason: `the agent did not finish within ${config.prepareTimeoutMinutes} minutes`, worktree: null, logPath, run };
    }

    const parsed = parseAgentOutput(stdout);
    run = { ...run, stats: parsed.stats };

    if (parsed.stats?.subtype === 'error_max_budget_usd') {
      await removeWorktree(clone, dest);
      // The cap can come from agent.extraArgs rather than agent.maxBudgetUsd, in which case the
      // daemon does not know the number the agent hit.
      const budget = config.agent.maxBudgetUsd;
      return { kind: 'failed', failure: 'budget', reason: budget === null ? 'the agent hit its budget' : `the agent hit its budget of $${budget}`, worktree: null, logPath, run };
    }

    // Nothing was reviewed and nothing is wrong with the pull request: the daemon waits the limit
    // out rather than spending the pull request's retries on it.
    const limit = rateLimitOf(parsed.text, new Date(run.endedAt));
    if (limit) {
      await removeWorktree(clone, dest);
      return {
        kind: 'failed', failure: 'rate-limit', worktree: null, logPath, run, resetsAt: limit.resetsAt,
        reason: limit.resetsAt
          ? `waiting: Claude session limit until ${localHhMm(limit.resetsAt)}`
          : 'waiting: Claude session limit, retrying in 30 minutes',
      };
    }

    const verdict = verdictOf(parsed.text);
    if (verdict.kind === 'skipped') {
      await removeWorktree(clone, dest);
      return { kind: 'skipped', reason: verdict.reason, logPath, run };
    }
    if (verdict.kind === 'none') {
      await removeWorktree(clone, dest);
      return { kind: 'failed', failure: 'agent', reason: 'the agent ended without SKIP or PREPARED', worktree: null, logPath, run };
    }

    // The draft stands whatever the check comes to, so this runs before the bundle is written and
    // never turns a prepared review into a failure.
    const validateRun = await checkFindings(snapshot, config, deps, { worktree: dest, port: server.port, logPath });
    const validation: Validation = validateRun === null
      ? 'not-needed'
      : validateRun.outcome === 'validated' ? 'validated' : 'unchecked';

    // The head actually checked out, which may be newer than the snapshot if the author pushed
    // between the search and the fetch; recording it keeps the next tick from calling it stale.
    const bundlePath = join(bundlesDir(), `${snapshot.owner}-${snapshot.repo}-${snapshot.number}-${head.slice(0, 12)}.json`);
    try {
      await deps.exportBundle({ worktree: dest, prNumber: snapshot.number, outPath: bundlePath });
    } catch (err) {
      return { kind: 'failed', failure: 'bundle', reason: `the review was prepared but its bundle could not be written: ${err instanceof Error ? err.message : err}`, worktree: dest, logPath, run };
    }

    return {
      kind: 'prepared', headSha: head, bundlePath, worktree: dest, logPath, at: deps.now(),
      summary: withValidation(summarizeBundleFile(bundlePath), validation), alert: verdict.alert,
      run, validation, validateRun,
    };
  } catch (err) {
    return { kind: 'failed', failure: 'agent', reason: err instanceof Error ? err.message : String(err), worktree: dest, logPath, run };
  } finally {
    server?.stop();
  }
}

/**
 * The second pass over the draft: the checking model reads the findings that would hold up a merge
 * against the code, and amends or dismisses the ones that do not stand. Null when there was
 * nothing to check — the pass is off, or the draft found no P1 or P2 — and otherwise a run the
 * caller keeps whether it finished or not, because the draft goes to the reviewer either way.
 */
async function checkFindings(
  snapshot: PrSnapshot,
  config: InboxConfig,
  deps: PrepareDeps,
  ctx: { worktree: string; port: number; logPath: string },
): Promise<ValidateRun | null> {
  if (config.validate.model === null) {
    return null;
  }
  const startedAt = deps.now();
  try {
    const drafted = await deps.listThreads(ctx.worktree);
    const threads = threadsToValidate(drafted);
    if (threads.length === 0) {
      return null;
    }
    const { stdout, timedOut } = await deps.runAgent({
      argv: deps.validateArgv(),
      prompt: composeValidatePrompt({
        snapshot, worktreePath: ctx.worktree, port: ctx.port, threads,
        generalCommentId: generalCommentIdOf(drafted),
      }),
      cwd: ctx.worktree,
      logPath: validateLogPath(ctx.logPath),
      timeoutMs: config.validate.timeoutMinutes * 60_000,
    });
    const endedAt = deps.now();
    if (timedOut) {
      return { startedAt, endedAt, stats: null, outcome: 'timeout', note: `the checking agent did not finish within ${config.validate.timeoutMinutes} minutes` };
    }
    const parsed = parseAgentOutput(stdout);
    const ran = { startedAt, endedAt, stats: parsed.stats };
    if (parsed.stats?.subtype === 'error_max_budget_usd') {
      const budget = config.validate.maxBudgetUsd;
      return { ...ran, outcome: 'failed', note: budget === null ? 'the checking agent hit its budget' : `the checking agent hit its budget of $${budget}` };
    }
    // Not a pause: the review itself is done, so it goes to the reviewer unchecked rather than
    // holding the queue for a limit that has nothing to do with this pull request.
    if (rateLimitOf(parsed.text, new Date(endedAt))) {
      return { ...ran, outcome: 'failed', note: 'the checking agent hit the Claude session limit' };
    }
    if (validateVerdictOf(parsed.text) === 'none') {
      return { ...ran, outcome: 'failed', note: 'the checking agent ended without VALIDATED' };
    }
    return { ...ran, outcome: 'validated', note: null };
  } catch (err) {
    return { startedAt, endedAt: deps.now(), stats: null, outcome: 'failed', note: `the findings could not be checked: ${err instanceof Error ? err.message : err}` };
  }
}

/** The checking agent's log, beside the drafting agent's rather than appended to it. */
function validateLogPath(logPath: string): string {
  return `${logPath.replace(/\.log$/, '')}.validate.log`;
}

/** What the card says about a draft nobody checked, so "1 P1" is not read as a settled one. */
function withValidation(summary: string | null, validation: Validation): string | null {
  if (validation !== 'unchecked') {
    return summary;
  }
  return summary === null ? 'unchecked' : `${summary} \u00b7 unchecked`;
}
