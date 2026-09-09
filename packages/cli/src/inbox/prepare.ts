import { join } from 'node:path';
import { GENERAL_THREAD_FILE_PATH } from '@diffity/api';
import type { PrComment, PrSnapshot, ReviewResult, ReviewSubmission } from '@diffity/github';
import type { InboxConfig } from './config.js';
import { prId } from './store.js';
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

/** One review for the forge, as the daemon itself posts it — never through the agent. */
export interface PostReviewOpts {
  owner: string;
  repo: string;
  prNumber: number;
  headSha: string;
  submission: ReviewSubmission;
}

/** What reached the forge, so the session the reviewer opens shows those findings as sent. */
export interface MarkPostedOpts {
  worktree: string;
  threadIds: string[];
  /** The forge comment each thread exists as, where the forge said which. */
  commentIds: { threadId: string; githubCommentId: number }[];
  reviewUrl: string | null;
  headSha: string;
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
  /**
   * The pull request's description and discussion, written where the agent can read it, with the
   * daemon's own credentials; the path to it, or null when the forge could not be read.
   */
  prContext(snapshot: PrSnapshot, worktree: string): Promise<string | null>;
  /** The daemon's own call to the forge, with its credentials — this is never the agent's. */
  postReview(opts: PostReviewOpts): Promise<ReviewResult>;
  markPosted(opts: MarkPostedOpts): void | Promise<void>;
  exportBundle(opts: ExportOpts): void | Promise<void>;
  log(message: string): void;
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

/** The review the daemon put the alert findings on the pull request in. */
export interface PostedReview {
  at: string;
  headSha: string;
  url: string | null;
  /** How many of the posted comments the forge gave an id back for. */
  commentIds: number;
}

export type PrepareResult =
  | { kind: 'prepared'; headSha: string; bundlePath: string; worktree: string; logPath: string; at: string; summary: string | null; alert: string | null; alertFindings: string[]; posted: PostedReview | null; run: RunLog; validation: Validation; validateRun: ValidateRun | null }
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
  /**
   * Review this commit rather than wherever the pull request has got to. Only a comparison against
   * an earlier review sets it; the daemon always takes the current head.
   */
  pinHead?: string;
  /** The head the alert findings have already been posted for, so no head is posted to twice. */
  alreadyPostedHead?: string | null;
  /** Why the reviewer's own rules flagged this one, when they did: a reason for an alert of itself. */
  triageReason?: string | null;
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
    ({ head, diffRef } = await prepareWorktree(clone, dest, snapshot, snapshot.baseRef, opts.pinHead));
  } catch (err) {
    return { kind: 'failed', failure: 'worktree', reason: err instanceof Error ? err.message : String(err), worktree: null, logPath: null, run };
  }

  let server: ServerHandle | null = null;
  try {
    server = await deps.startServer(dest, diffRef);
    // Starting the server empties the pull request's data directory, which is where the discussion
    // is written, so it is read after that and before the agent.
    const contextPath = await prContextPath(snapshot, deps, dest);
    const startedAt = deps.now();
    const { stdout, timedOut } = await deps.runAgent({
      argv: deps.agentArgv(),
      prompt: composePrompt({
        snapshot, worktreePath: dest, port: server.port, alertWhen: config.alertWhen,
        filter: opts.bumped ? '' : config.filter, mcpAllow: config.agent.mcpAllow, contextPath,
        postPrefix: config.postAlerts ? config.postPrefix : null,
        triageReason: opts.triageReason ?? null,
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

    // Before the bundle, so the threads it carries already know they are on the pull request; the
    // worktree's own server is still up, which is what the thread listing reads through.
    const posted = await postAlertFindings(snapshot, config, deps, {
      worktree: dest, head, alert: verdict.alert, alertFindings: verdict.alertFindings,
      alreadyPostedHead: opts.alreadyPostedHead ?? null,
    });

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
      alertFindings: verdict.alertFindings, posted, run, validation, validateRun,
    };
  } catch (err) {
    return { kind: 'failed', failure: 'agent', reason: err instanceof Error ? err.message : String(err), worktree: dest, logPath, run };
  } finally {
    server?.stop();
  }
}

/**
 * Where the pull request's discussion was written for the agent, or nothing: a review that has to
 * do without the description and the comments is still a review, so a forge that cannot be read
 * costs a log line rather than the preparation.
 */
async function prContextPath(snapshot: PrSnapshot, deps: PrepareDeps, worktree: string): Promise<string | null> {
  try {
    return await deps.prContext(snapshot, worktree);
  } catch (err) {
    deps.log(`${prId(snapshot)}: the discussion could not be read \u2014 ${err instanceof Error ? err.message : err}`);
    return null;
  }
}

/**
 * Puts the findings the agent named behind its alert on the pull request, as one `COMMENT` review
 * in the reviewer's name, every comment opening with the configured prefix so nobody reads it as a
 * verdict a human has stood behind. An alert that named no findings is posted as its reason alone,
 * which is all there is to say; one whose named findings are all settled by the time the review
 * goes out is not posted at all, because the checking pass has just rejected everything the alert
 * rests on. Null when nothing was posted: that case, the setting being off, no alert of the
 * agent's own, a head that has been posted to already, or a post that did not go through — the
 * review is prepared either way, and the reviewer still has the alert and the findings.
 */
async function postAlertFindings(
  snapshot: PrSnapshot,
  config: InboxConfig,
  deps: PrepareDeps,
  ctx: { worktree: string; head: string; alert: string | null; alertFindings: string[]; alreadyPostedHead: string | null },
): Promise<PostedReview | null> {
  if (!config.postAlerts || ctx.alert === null || ctx.alreadyPostedHead === ctx.head) {
    return null;
  }
  const id = prId(snapshot);
  try {
    const comments = alertComments(await deps.listThreads(ctx.worktree), ctx.alertFindings, config.postPrefix);
    if (ctx.alertFindings.length > 0 && comments.length === 0) {
      deps.log(`${id}: the alert's findings did not survive the check — nothing posted`);
      return null;
    }
    const result = await deps.postReview({
      owner: snapshot.owner,
      repo: snapshot.repo,
      prNumber: snapshot.number,
      headSha: ctx.head,
      // Never a verdict: the reviewer has not read this yet, and only they approve or request changes.
      submission: { event: 'COMMENT', body: reviewBody(config, ctx.alert), comments },
    });
    if (result.reviewUrl === null) {
      deps.log(`could not post alert findings to ${id}: ${result.errors.join('; ') || 'the forge created no review'}`);
      return null;
    }
    deps.log(`posted ${result.submitted} alert finding(s) to ${id} — ${result.reviewUrl}`);
    if (result.errors.length > 0) {
      deps.log(`${id}: ${result.errors.length} alert finding(s) were left off the review — ${result.errors.join('; ')}`);
    }
    await markPostedThreads(deps, { worktree: ctx.worktree, headSha: ctx.head, id, result });
    return { at: deps.now(), headSha: ctx.head, url: result.reviewUrl, commentIds: result.commentIds.length };
  } catch (err) {
    deps.log(`could not post alert findings to ${id}: ${err instanceof Error ? err.message : err}`);
    return null;
  }
}

/**
 * The posted review's own body: the reason behind the prefix, and the reviewer's footer under it
 * when they have one. Only this body carries the footer, so a team mention in it fires once for
 * the review rather than once per finding.
 */
function reviewBody(config: InboxConfig, alert: string): string {
  const opening = `${config.postPrefix} ${alert}`;
  const footer = config.postFooter.trim();
  return footer === '' ? opening : `${opening}\n\n${footer}`;
}

/**
 * The named findings as forge comments, in the order the agent named them: the ones still open
 * after the checking pass — a dismissed or resolved finding is settled and does not go out — each
 * body opening with the prefix on a line of its own. The general summary is not a finding and is
 * never posted as one; the review's body carries the reason instead.
 */
function alertComments(threads: ReviewThread[], named: string[], prefix: string): PrComment[] {
  const postable = threads.filter(thread => thread.status === 'open' && thread.filePath !== GENERAL_THREAD_FILE_PATH);
  const comments: PrComment[] = [];
  for (const id of named) {
    // The agent names findings by the 8-character prefix `agent comment` printed, or in full.
    const thread = postable.find(one => one.threadId === id || one.threadId.startsWith(id));
    const body = thread?.comments[0]?.body;
    if (!thread || !body || comments.some(already => already.threadId === thread.threadId)) {
      continue;
    }
    comments.push({
      threadId: thread.threadId,
      filePath: thread.filePath,
      side: thread.side === 'old' ? 'LEFT' : 'RIGHT',
      startLine: thread.startLine === thread.endLine ? null : thread.startLine,
      endLine: thread.endLine,
      body: `${prefix}\n\n${body}`,
    });
  }
  return comments;
}

/**
 * Marks what left the machine as sent, so the session the reviewer opens does not offer to send it
 * again. A marking that fails is worth saying so and no more: the comments are on the pull request
 * whether or not the local session knows it.
 */
async function markPostedThreads(
  deps: PrepareDeps,
  ctx: { worktree: string; headSha: string; id: string; result: ReviewResult },
): Promise<void> {
  if (ctx.result.submittedThreadIds.length === 0) {
    return;
  }
  try {
    await deps.markPosted({
      worktree: ctx.worktree,
      threadIds: ctx.result.submittedThreadIds,
      commentIds: ctx.result.commentIds,
      reviewUrl: ctx.result.reviewUrl,
      headSha: ctx.headSha,
    });
  } catch (err) {
    deps.log(`${ctx.id}: the posted findings could not be marked as sent — ${err instanceof Error ? err.message : err}`);
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
