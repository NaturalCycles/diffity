import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { preparePr, type MarkPostedOpts, type PostReviewOpts, type PrepareDeps } from '../src/inbox/prepare.js';
import type { ReviewThread } from '../src/inbox/validate.js';
import { worktreePath } from '../src/inbox/worktree.js';
import { startInboxServer } from '../src/inbox/daemon.js';
import { InboxStore } from '../src/inbox/store.js';
import { buildView } from '../src/inbox/view.js';
import type { AgentConfig, InboxConfig, ValidateConfig } from '../src/inbox/config.js';
import type { PrSnapshot, ReviewResult } from '@diffity/github';

/** The built-in agent settings, fresh each call so a test cannot leak into the next. */
function agentConfig(): AgentConfig {
  return { model: null, effort: null, mcpAllow: [], extraArgs: [], maxBudgetUsd: null };
}

/** The second pass off, as it ships; a test that wants it names its own model. */
function validateConfig(): ValidateConfig {
  return { model: null, timeoutMinutes: 15, maxBudgetUsd: null };
}

let root: string;
let reposDir: string;
let worktreesDir: string;
let head: string;

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, stdio: 'pipe', encoding: 'utf-8' }).trim();
}

function snapshot(): PrSnapshot {
  return {
    owner: 'o', repo: 'demo', number: 4, title: 'A change', body: '', url: 'https://github.com/o/demo/pull/4',
    author: 'alice', isBot: false, isDraft: false, state: 'OPEN', headSha: head, baseRef: 'main',
    additions: 1, deletions: 0, changedFiles: 1, createdAt: 'now', updatedAt: 'now', checks: [], files: [],
  };
}

function config(): InboxConfig {
  return {
    pollMinutes: 5, port: 0, reposDir, worktreesDir, filter: '', skipTitles: [], alertWhen: '', alertPaths: [],
    postAlerts: false, postPrefix: '[not yet checked by human]', postFooter: '',
    agent: agentConfig(), validate: validateConfig(), waitForCi: false, prepareTimeoutMinutes: 30, maxPrepared: 5, live: true, liveTimeoutMinutes: 10,
  };
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'diffity-inbox-'));
  reposDir = join(root, 'repos');
  worktreesDir = join(root, 'inbox', 'worktrees');

  // An upstream the base clone fetches from, carrying the pull request's head under refs/pull/4/head.
  // Pathed as .../o/demo so the clone's origin url passes the repository-identity check.
  const upstream = join(root, 'remotes', 'o', 'demo');
  execFileSync('git', ['init', '-b', 'main', upstream], { stdio: 'pipe' });
  git(upstream, ['config', 'user.email', 't@t']);
  git(upstream, ['config', 'user.name', 'T']);
  writeFileSync(join(upstream, 'a.ts'), 'const a = 1;\n');
  git(upstream, ['add', '.']);
  git(upstream, ['commit', '-m', 'init']);
  git(upstream, ['update-ref', 'refs/pull/4/head', 'HEAD']);
  head = git(upstream, ['rev-parse', 'HEAD']);

  // The base clone the worktree is cut from, with origin pointing at the upstream.
  const clone = join(reposDir, 'demo');
  execFileSync('git', ['clone', '--quiet', upstream, clone], { stdio: 'pipe' });
  git(clone, ['config', 'user.email', 't@t']);
  git(clone, ['config', 'user.name', 'T']);
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

beforeEach(() => {
  prompts = [];
  argvs = [];
  logs = [];
  timeouts = [];
  daemonLog = [];
  submissions = [];
  contextCalls = [];
  marked = [];
  reviewResult = opts => ({
    submitted: opts.submission.comments.length,
    submittedThreadIds: opts.submission.comments.map(comment => comment.threadId!),
    commentIds: opts.submission.comments.map((comment, index) => ({ threadId: comment.threadId!, githubCommentId: 500 + index })),
    skipped: 0, failed: 0, errors: [],
    reviewUrl: 'https://github.com/o/demo/pull/4#pullrequestreview-9',
  });
});

let prompts: string[] = [];
let argvs: string[][] = [];
let logs: string[] = [];
let timeouts: number[] = [];
let daemonLog: string[] = [];
let submissions: PostReviewOpts[] = [];
let contextCalls: { snapshot: PrSnapshot; worktree: string }[] = [];
let marked: MarkPostedOpts[] = [];
let reviewResult: (opts: PostReviewOpts) => ReviewResult;

/** A drafted P1 finding, as `listThreads` reports one. */
function draftedThread(over: Partial<ReviewThread> = {}): ReviewThread {
  return {
    threadId: 't1', filePath: 'a.ts', startLine: 1, endLine: 1, side: 'new', status: 'open',
    comments: [{ id: 'c1', body: 'P1: this leaks the token' }],
    ...over,
  };
}

/** The second pass on, with a model and a budget of its own. */
function checking(): InboxConfig {
  return { ...config(), validate: { model: 'the-checking-model', timeoutMinutes: 15, maxBudgetUsd: 2 } };
}

function deps(over: Partial<PrepareDeps> = {}): PrepareDeps {
  return {
    startServer: () => Promise.resolve({ port: 5555, stop: () => {} }),
    agentArgv: () => ['claude', '-p', '--output-format', 'json'],
    validateArgv: () => ['claude', '-p', '--model', 'the-checking-model'],
    listThreads: () => Promise.resolve([]),
    prContext: (snapshot, worktree) => {
      contextCalls.push({ snapshot, worktree });
      return Promise.resolve('/data/o-demo-4/pr-context.json');
    },
    runAgent: ({ cwd, prompt, argv, logPath, timeoutMs }) => {
      prompts.push(prompt);
      argvs.push(argv);
      logs.push(logPath);
      timeouts.push(timeoutMs);
      // The worktree exists and holds the checked-out file by the time the agent runs.
      expect(existsSync(join(cwd, 'a.ts'))).toBe(true);
      return Promise.resolve({ stdout: 'reviewing\nPREPARED\n', timedOut: false });
    },
    exportBundle: ({ outPath }) => {
      mkdirSync(dirname(outPath), { recursive: true });
      writeFileSync(outPath, '{"bundle":true}\n');
    },
    postReview: opts => { submissions.push(opts); return Promise.resolve(reviewResult(opts)); },
    markPosted: opts => { marked.push(opts); },
    log: message => { daemonLog.push(message); },
    now: () => '2026-09-02T12:00:00.000Z',
    ...over,
  };
}

describe('preparePr', () => {
  it('cuts a worktree, runs the built agent command, exports a bundle, and keeps the worktree', async () => {
    argvs = [];
    const result = await preparePr(snapshot(), config(), deps());

    expect(result.kind).toBe('prepared');
    if (result.kind !== 'prepared') return;
    expect(existsSync(result.worktree)).toBe(true);
    expect(readFileSync(result.bundlePath, 'utf-8')).toContain('bundle');
    expect(result.headSha).toBe(snapshot().headSha);
    expect(argvs[0]).toEqual(['claude', '-p', '--output-format', 'json']);
  });

  it('reads the discussion before the agent runs and points the prompt at it', async () => {
    const result = await preparePr(snapshot(), config(), deps());

    expect(contextCalls).toEqual([{ snapshot: snapshot(), worktree: worktreePath(worktreesDir, snapshot()) }]);
    expect(prompts[0]).toContain('/data/o-demo-4/pr-context.json');
    expect(result.kind).toBe('prepared');
  });

  it('reviews without the discussion when the forge could not be read', async () => {
    const result = await preparePr(snapshot(), config(), deps({ prContext: () => Promise.resolve(null) }));

    expect(prompts[0]).not.toContain('pr-context.json');
    expect(result.kind).toBe('prepared');
  });

  it('reviews without the discussion when reading it threw, and logs why', async () => {
    const result = await preparePr(snapshot(), config(), deps({
      prContext: () => Promise.reject(new Error('gh pr view failed: no access')),
    }));

    expect(daemonLog).toContain('o/demo#4: the discussion could not be read \u2014 gh pr view failed: no access');
    expect(prompts[0]).not.toContain('pr-context.json');
    expect(result.kind).toBe('prepared');
  });

  it('reads the verdict out of a JSON result and carries the run\'s stats', async () => {
    const result = await preparePr(snapshot(), config(), deps({
      runAgent: () => Promise.resolve({
        stdout: JSON.stringify({
          type: 'result', subtype: 'success', result: 'reviewing\nPREPARED', total_cost_usd: 1.25, duration_ms: 60_000,
          num_turns: 12, usage: { input_tokens: 30, output_tokens: 900 }, modelUsage: { 'claude-x': {} },
        }),
        timedOut: false,
      }),
    }));

    expect(result.kind).toBe('prepared');
    expect(result.run.stats).toMatchObject({ costUsd: 1.25, turns: 12, outputTokens: 900, models: ['claude-x'], subtype: 'success' });
  });

  it('fails with the budget as the reason when the agent hit it', async () => {
    const dest = worktreePath(worktreesDir, snapshot());
    const result = await preparePr(snapshot(), { ...config(), agent: { ...agentConfig(), maxBudgetUsd: 3 } }, deps({
      runAgent: () => Promise.resolve({
        stdout: JSON.stringify({ type: 'result', subtype: 'error_max_budget_usd', result: '', is_error: true }),
        timedOut: false,
      }),
    }));

    expect(result.kind).toBe('failed');
    if (result.kind !== 'failed') return;
    expect(result.failure).toBe('budget');
    expect(result.reason).toBe('the agent hit its budget of $3');
    expect(existsSync(dest)).toBe(false);
  });

  it('leaves the number out when the budget came from somewhere the daemon cannot see', async () => {
    // A `--max-budget-usd` in agent.extraArgs caps the run without maxBudgetUsd being set.
    const result = await preparePr(snapshot(), { ...config(), agent: { ...agentConfig(), extraArgs: ['--max-budget-usd', '3'] } }, deps({
      runAgent: () => Promise.resolve({
        stdout: JSON.stringify({ type: 'result', subtype: 'error_max_budget_usd', result: '', is_error: true }),
        timedOut: false,
      }),
    }));

    expect(result.kind === 'failed' && result.reason).toBe('the agent hit its budget');
  });

  it('removes the worktree when the agent skips', async () => {
    const dest = worktreePath(worktreesDir, snapshot());
    const result = await preparePr(snapshot(), config(), deps({
      runAgent: () => Promise.resolve({ stdout: 'SKIP: payments PR\n', timedOut: false }),
    }));

    expect(result.kind).toBe('skipped');
    if (result.kind !== 'skipped') return;
    expect(result.reason).toBe('payments PR');
    expect(existsSync(dest)).toBe(false);
  });

  it('fails cleanly when there is no local clone', async () => {
    const cfg = { ...config(), reposDir: join(root, 'nowhere') };
    const result = await preparePr(snapshot(), cfg, deps());
    expect(result.kind).toBe('failed');
    if (result.kind !== 'failed') return;
    // Nothing was run, so the tick has no run to log for it.
    expect(result.failure).toBe('worktree');
    expect(result.reason).toContain('No local clone');
  });

  it('fails when the agent times out, without a leftover worktree', async () => {
    const dest = worktreePath(worktreesDir, snapshot());
    const result = await preparePr(snapshot(), config(), deps({
      runAgent: () => Promise.resolve({ stdout: '', timedOut: true }),
    }));
    expect(result.kind).toBe('failed');
    if (result.kind !== 'failed') return;
    expect(result.failure).toBe('timeout');
    expect(result.reason).toContain('did not finish');
    expect(existsSync(dest)).toBe(false);
  });

  it('says when the agent started and ended, around the run itself', async () => {
    const clock = [
      '2026-09-07T11:59:00.000Z', '2026-09-07T12:00:00.000Z',
      '2026-09-07T12:08:00.000Z', '2026-09-07T12:08:01.000Z',
    ];
    const result = await preparePr(snapshot(), config(), deps({ now: () => clock.shift() ?? 'later' }));

    expect(result.run).toEqual({ startedAt: '2026-09-07T12:00:00.000Z', endedAt: '2026-09-07T12:08:00.000Z', stats: null });
    expect(result.kind === 'prepared' && result.at).toBe('2026-09-07T12:08:01.000Z');
  });

  it('waits out a session limit instead of holding it against the pull request', async () => {
    const dest = worktreePath(worktreesDir, snapshot());
    const result = await preparePr(snapshot(), config(), deps({
      runAgent: () => Promise.resolve({
        stdout: "Claude AI usage limit reached. You've hit your session limit \u00b7 resets 2pm (Europe/Stockholm)\n",
        timedOut: false,
      }),
    }));

    expect(result.kind).toBe('failed');
    if (result.kind !== 'failed') return;
    expect(result.failure).toBe('rate-limit');
    expect(result.reason).toMatch(/^waiting: Claude session limit until \d\d:\d\d$/);
    expect(result.resetsAt).toMatch(/^20\d\d-\d\d-\d\dT/);
    expect(existsSync(dest)).toBe(false);
  });

  it('leaves the retry to the caller when the limit named no time', async () => {
    const result = await preparePr(snapshot(), config(), deps({
      runAgent: () => Promise.resolve({
        stdout: JSON.stringify({ type: 'result', subtype: 'success', is_error: true, result: "You've hit your usage limit" }),
        timedOut: false,
      }),
    }));

    expect(result.kind === 'failed' && [result.failure, result.reason, result.resetsAt])
      .toEqual(['rate-limit', 'waiting: Claude session limit, retrying in 30 minutes', null]);
  });

  it('does not run a second pass when no model is set for it', async () => {
    let listed = 0;
    const result = await preparePr(snapshot(), config(), deps({ listThreads: () => { listed++; return Promise.resolve([]); } }));

    expect(result.kind === 'prepared' && [result.validation, result.validateRun]).toEqual(['not-needed', null]);
    expect(argvs).toEqual([['claude', '-p', '--output-format', 'json']]);
    // The threads are not even read: nothing would be done with them.
    expect(listed).toBe(0);
  });

  it('does not run a second pass when the draft found no P1 or P2', async () => {
    const result = await preparePr(snapshot(), checking(), deps({
      listThreads: () => Promise.resolve([draftedThread({ comments: [{ id: 'c1', body: 'P3: a nit' }] })]),
    }));

    expect(result.kind === 'prepared' && result.validation).toBe('not-needed');
    expect(argvs).toHaveLength(1);
  });

  it('checks the P1 and P2 findings with the checking command, and takes VALIDATED for done', async () => {
    const result = await preparePr(snapshot(), checking(), deps({
      listThreads: () => Promise.resolve([
        draftedThread(),
        draftedThread({ threadId: 'g', filePath: '__general__', comments: [{ id: 'gc', body: 'Looks good, 1 P1' }] }),
      ]),
      runAgent: ({ argv, prompt, logPath, timeoutMs }) => {
        argvs.push(argv);
        prompts.push(prompt);
        logs.push(logPath);
        timeouts.push(timeoutMs);
        return Promise.resolve({ stdout: argvs.length === 1 ? 'reviewing\nPREPARED\n' : 'checked it\nVALIDATED\n', timedOut: false });
      },
      exportBundle: ({ outPath }) => {
        mkdirSync(dirname(outPath), { recursive: true });
        writeFileSync(outPath, JSON.stringify({ threads: [{ filePath: 'a.ts', status: 'open', comments: [{ body: 'P1: bad', kind: 'review' }] }] }));
      },
    }));

    expect(result.kind === 'prepared' && result.validation).toBe('validated');
    expect(result.kind === 'prepared' && result.validateRun?.outcome).toBe('validated');
    expect(result.kind === 'prepared' && result.validateRun?.note).toBeNull();
    // The summary is the bundle's own: a checked draft says nothing about having been checked.
    expect(result.kind === 'prepared' && result.summary).toBe('1 P1');
    expect(argvs[1]).toEqual(['claude', '-p', '--model', 'the-checking-model']);
    expect(prompts[1]).toContain('--- thread t1');
    expect(prompts[1]).toContain('    comment c1');
    expect(prompts[1]).toContain('its comment id is\n  gc');
    // Its own log beside the drafting agent's, and its own timeout.
    expect(logs[1]).toBe(logs[0].replace(/\.log$/, '.validate.log'));
    expect(timeouts).toEqual([30 * 60_000, 15 * 60_000]);
  });

  it('drops a finding the checking pass dismissed from the summary the card shows', async () => {
    const result = await preparePr(snapshot(), checking(), deps({
      listThreads: () => Promise.resolve([draftedThread()]),
      runAgent: ({ argv }) => {
        argvs.push(argv);
        return Promise.resolve({ stdout: argvs.length === 1 ? 'PREPARED\n' : 'VALIDATED\n', timedOut: false });
      },
      // The bundle keeps a dismissed thread, so the count has to read its status.
      exportBundle: ({ outPath }) => {
        mkdirSync(dirname(outPath), { recursive: true });
        writeFileSync(outPath, JSON.stringify({ threads: [
          { filePath: 'a.ts', status: 'dismissed', comments: [{ body: 'P1: this does not hold', kind: 'review' }] },
          { filePath: 'a.ts', status: 'open', comments: [{ body: 'P3: a nit', kind: 'review' }] },
        ] }));
      },
    }));

    expect(result.kind === 'prepared' && result.summary).toBe('1 P3');
  });

  it('keeps the draft and marks it unchecked when the checking agent times out', async () => {
    const result = await preparePr(snapshot(), checking(), deps({
      listThreads: () => Promise.resolve([draftedThread()]),
      runAgent: ({ argv }) => {
        argvs.push(argv);
        return argvs.length === 1
          ? Promise.resolve({ stdout: 'PREPARED\n', timedOut: false })
          : Promise.resolve({ stdout: '', timedOut: true });
      },
      exportBundle: ({ outPath }) => {
        mkdirSync(dirname(outPath), { recursive: true });
        writeFileSync(outPath, JSON.stringify({ threads: [{ filePath: 'a.ts', status: 'open', comments: [{ body: 'P1: bad', kind: 'review' }] }] }));
      },
    }));

    expect(result.kind).toBe('prepared');
    if (result.kind !== 'prepared') return;
    expect(result.validation).toBe('unchecked');
    expect(result.summary).toBe('1 P1 \u00b7 unchecked');
    expect(result.validateRun?.outcome).toBe('timeout');
    expect(result.validateRun?.note).toContain('did not finish within 15 minutes');
    // The draft is still on disk, and the worktree still there to open.
    expect(existsSync(result.bundlePath)).toBe(true);
    expect(existsSync(result.worktree)).toBe(true);
  });

  it('marks the draft unchecked on a verdictless run, a budget, a session limit, and a broken listing', async () => {
    const checked = async (over: Partial<PrepareDeps>) => {
      const result = await preparePr(snapshot(), checking(), deps({ listThreads: () => Promise.resolve([draftedThread()]), ...over }));
      return result.kind === 'prepared' ? [result.validation, result.validateRun?.outcome, result.validateRun?.note] : ['not prepared'];
    };
    const secondRun = (stdout: string) => ({
      runAgent: ({ argv }: { argv: string[] }) => {
        argvs.push(argv);
        return Promise.resolve({ stdout: argvs.length === 1 ? 'PREPARED\n' : stdout, timedOut: false });
      },
    });

    argvs = [];
    expect(await checked(secondRun('had a look and stopped\n')))
      .toEqual(['unchecked', 'failed', 'the checking agent ended without VALIDATED']);

    argvs = [];
    expect(await checked(secondRun(JSON.stringify({ type: 'result', subtype: 'error_max_budget_usd', result: '', is_error: true }))))
      .toEqual(['unchecked', 'failed', 'the checking agent hit its budget of $2']);

    argvs = [];
    expect(await checked(secondRun("You've hit your session limit \u00b7 resets 2pm\n")))
      .toEqual(['unchecked', 'failed', 'the checking agent hit the Claude session limit']);

    argvs = [];
    expect(await checked({ listThreads: () => Promise.reject(new Error('no session')) }))
      .toEqual(['unchecked', 'failed', 'the findings could not be checked: no session']);
  });

  it('always stops the diffity server, even on a failure', async () => {
    let stopped = 0;
    await preparePr(snapshot(), config(), deps({
      startServer: () => Promise.resolve({ port: 1, stop: () => { stopped++; } }),
      exportBundle: () => { throw new Error('disk full'); },
    }));
    expect(stopped).toBe(1);
  });
});

describe('posting the findings behind an alert', () => {
  const FULL_ID = 'cf15e689-1111-2222-3333-444455556666';

  /** The agent's output for a review it flagged, naming the findings behind the flag. */
  function alerting(...findings: string[]): Partial<PrepareDeps> {
    return {
      runAgent: () => Promise.resolve({
        stdout: `reviewing\nALERT: touches auth\nALERT-FINDINGS: ${findings.join(' ')}\nPREPARED\n`,
        timedOut: false,
      }),
    };
  }

  /** The setting on, with a prefix short enough to read in an assertion. */
  function posting(): InboxConfig {
    return { ...config(), postAlerts: true, postPrefix: '[not yet checked by human]' };
  }

  function named(over: Partial<ReviewThread> = {}): ReviewThread {
    return draftedThread({ threadId: FULL_ID, ...over });
  }

  it('posts one comment review, the reason as its body and each finding prefixed', async () => {
    const result = await preparePr(snapshot(), posting(), deps({
      ...alerting('cf15e689'),
      listThreads: () => Promise.resolve([named()]),
    }));

    expect(submissions).toHaveLength(1);
    expect(submissions[0]).toMatchObject({ owner: 'o', repo: 'demo', prNumber: 4, headSha: head });
    expect(submissions[0].submission.event).toBe('COMMENT');
    expect(submissions[0].submission.body).toBe('[not yet checked by human] touches auth');
    expect(submissions[0].submission.comments).toEqual([{
      threadId: FULL_ID, filePath: 'a.ts', side: 'RIGHT', startLine: null, endLine: 1,
      body: '[not yet checked by human]\n\nP1: this leaks the token',
    }]);
    expect(result.kind === 'prepared' && result.posted).toEqual({
      at: '2026-09-02T12:00:00.000Z', headSha: head,
      url: 'https://github.com/o/demo/pull/4#pullrequestreview-9', commentIds: 1,
    });
    expect(daemonLog).toContain('posted 1 alert finding(s) to o/demo#4 — https://github.com/o/demo/pull/4#pullrequestreview-9');
  });

  it('ends the review body with the reviewer\'s footer, and leaves the comments unchanged', async () => {
    const withFooter = { ...posting(), postFooter: 'cc @NaturalCycles/platform\nAutomated triage, not a review.' };
    await preparePr(snapshot(), withFooter, deps({
      ...alerting('cf15e689'),
      listThreads: () => Promise.resolve([named()]),
    }));

    expect(submissions[0].submission.body)
      .toBe('[not yet checked by human] touches auth\n\ncc @NaturalCycles/platform\nAutomated triage, not a review.');
    expect(submissions[0].submission.comments[0].body).toBe('[not yet checked by human]\n\nP1: this leaks the token');
  });

  it('adds nothing when the footer is empty or only spaces', async () => {
    await preparePr(snapshot(), { ...posting(), postFooter: '  \n ' }, deps({
      ...alerting('cf15e689'),
      listThreads: () => Promise.resolve([named()]),
    }));

    expect(submissions[0].submission.body).toBe('[not yet checked by human] touches auth');
  });

  it('marks what went out as sent, with the forge comment id it went out as', async () => {
    await preparePr(snapshot(), posting(), deps({
      ...alerting('cf15e689'),
      listThreads: () => Promise.resolve([named()]),
    }));

    expect(marked).toEqual([{
      worktree: worktreePath(worktreesDir, snapshot()),
      threadIds: [FULL_ID],
      commentIds: [{ threadId: FULL_ID, githubCommentId: 500 }],
      reviewUrl: 'https://github.com/o/demo/pull/4#pullrequestreview-9',
      headSha: head,
    }]);
  });

  it('posts nothing while the setting is off, however loud the alert', async () => {
    const result = await preparePr(snapshot(), config(), deps({
      ...alerting('cf15e689'),
      listThreads: () => Promise.resolve([named()]),
    }));

    expect(submissions).toEqual([]);
    expect(result.kind === 'prepared' && [result.alert, result.posted]).toEqual(['touches auth', null]);
  });

  it('posts nothing when the agent raised no alert of its own', async () => {
    const result = await preparePr(snapshot(), posting(), deps({ listThreads: () => Promise.resolve([named()]) }));

    expect(submissions).toEqual([]);
    expect(result.kind === 'prepared' && result.posted).toBeNull();
  });

  it('posts nothing a second time for a head it has already posted for', async () => {
    const result = await preparePr(snapshot(), posting(), deps({
      ...alerting('cf15e689'),
      listThreads: () => Promise.resolve([named()]),
    }), { alreadyPostedHead: head });

    expect(submissions).toEqual([]);
    expect(result.kind === 'prepared' && result.posted).toBeNull();
  });

  it('posts for a bumped preparation, and again once the head has moved on', async () => {
    await preparePr(snapshot(), posting(), deps({
      ...alerting('cf15e689'),
      listThreads: () => Promise.resolve([named()]),
    }), { bumped: true, alreadyPostedHead: 'an-older-head' });

    expect(submissions).toHaveLength(1);
  });

  it('posts the reason alone when the agent named no findings for it', async () => {
    const result = await preparePr(snapshot(), posting(), deps({
      ...alerting(),
      listThreads: () => Promise.resolve([named()]),
    }));

    expect(submissions[0].submission.comments).toEqual([]);
    expect(submissions[0].submission.body).toBe('[not yet checked by human] touches auth');
    expect(result.kind === 'prepared' && result.posted?.commentIds).toBe(0);
    expect(daemonLog).toContain('posted 0 alert finding(s) to o/demo#4 — https://github.com/o/demo/pull/4#pullrequestreview-9');
  });

  it('posts nothing when every finding the alert named has been settled', async () => {
    const result = await preparePr(snapshot(), posting(), deps({
      ...alerting('cf15e689', 'aaaabbbb', '11112222', '99999999'),
      listThreads: () => Promise.resolve([
        named({ status: 'dismissed' }),
        named({ threadId: 'aaaabbbb-1111-2222-3333-444455556666', status: 'resolved' }),
        named({ threadId: '11112222-1111-2222-3333-444455556666', filePath: '__general__', startLine: 0, endLine: 0 }),
      ]),
    }));

    expect(submissions).toEqual([]);
    expect(daemonLog).toContain('o/demo#4: the alert\'s findings did not survive the check — nothing posted');
    // The reviewer still gets the alert; it is the author who is not told about a rejected finding.
    expect(result.kind === 'prepared' && [result.alert, result.posted]).toEqual(['touches auth', null]);
  });

  it('posts the findings that survived, leaving out the settled one beside them', async () => {
    const survivor = 'aaaabbbb-1111-2222-3333-444455556666';
    await preparePr(snapshot(), posting(), deps({
      ...alerting('cf15e689', 'aaaabbbb'),
      listThreads: () => Promise.resolve([
        named({ status: 'dismissed' }),
        named({ threadId: survivor, startLine: 2, endLine: 2, comments: [{ id: 'c2', body: 'P1: and this one holds' }] }),
      ]),
    }));

    expect(submissions[0].submission.comments).toEqual([{
      threadId: survivor, filePath: 'a.ts', side: 'RIGHT', startLine: null, endLine: 2,
      body: '[not yet checked by human]\n\nP1: and this one holds',
    }]);
  });

  it('names a finding by its printed prefix or in full, and posts it once either way', async () => {
    await preparePr(snapshot(), posting(), deps({
      ...alerting('cf15e689', FULL_ID),
      listThreads: () => Promise.resolve([named({ startLine: 3, endLine: 5, side: 'old' })]),
    }));

    expect(submissions[0].submission.comments).toEqual([{
      threadId: FULL_ID, filePath: 'a.ts', side: 'LEFT', startLine: 3, endLine: 5,
      body: '[not yet checked by human]\n\nP1: this leaks the token',
    }]);
  });

  it('leaves the review prepared and the alert standing when the forge refuses the post', async () => {
    reviewResult = () => ({
      submitted: 0, submittedThreadIds: [], commentIds: [], skipped: 0, failed: 1,
      errors: ['gh: 422 Unprocessable Entity'], reviewUrl: null,
    });
    const result = await preparePr(snapshot(), posting(), deps({
      ...alerting('cf15e689'),
      listThreads: () => Promise.resolve([named()]),
    }));

    expect(result.kind).toBe('prepared');
    expect(result.kind === 'prepared' && [result.alert, result.posted]).toEqual(['touches auth', null]);
    expect(marked).toEqual([]);
    expect(daemonLog).toContain('could not post alert findings to o/demo#4: gh: 422 Unprocessable Entity');
  });

  it('says so when the post threw, or when the forge made no review and said nothing', async () => {
    const failed = async (over: Partial<PrepareDeps>) => {
      daemonLog = [];
      const result = await preparePr(snapshot(), posting(), deps({
        ...alerting('cf15e689'), listThreads: () => Promise.resolve([named()]), ...over,
      }));
      return [result.kind === 'prepared' && result.posted, daemonLog[0]];
    };

    expect(await failed({ postReview: () => Promise.reject(new Error('gh is not logged in')) }))
      .toEqual([null, 'could not post alert findings to o/demo#4: gh is not logged in']);
    expect(await failed({ listThreads: () => Promise.reject(new Error('no session')) }))
      .toEqual([null, 'could not post alert findings to o/demo#4: no session']);

    reviewResult = () => ({ submitted: 0, submittedThreadIds: [], commentIds: [], skipped: 0, failed: 0, errors: [], reviewUrl: null });
    expect(await failed({}))
      .toEqual([null, 'could not post alert findings to o/demo#4: the forge created no review']);
  });

  it('says which findings the forge would not take, without losing the ones it did', async () => {
    reviewResult = opts => ({
      submitted: 1,
      submittedThreadIds: [FULL_ID],
      commentIds: [{ threadId: FULL_ID, githubCommentId: 500 }],
      skipped: 0, failed: 1, errors: ['b.ts:9 — not in PR diff'],
      reviewUrl: 'https://github.com/o/demo/pull/4#pullrequestreview-9',
    });
    const result = await preparePr(snapshot(), posting(), deps({
      ...alerting('cf15e689'),
      listThreads: () => Promise.resolve([named()]),
    }));

    expect(result.kind === 'prepared' && result.posted?.url).toBe('https://github.com/o/demo/pull/4#pullrequestreview-9');
    expect(daemonLog).toContain('o/demo#4: 1 alert finding(s) were left off the review — b.ts:9 — not in PR diff');
  });

  it('keeps the post when the session could not be told about it', async () => {
    const result = await preparePr(snapshot(), posting(), deps({
      ...alerting('cf15e689'),
      listThreads: () => Promise.resolve([named()]),
      markPosted: () => Promise.reject(new Error('the session is gone')),
    }));

    expect(result.kind === 'prepared' && result.posted?.commentIds).toBe(1);
    expect(daemonLog).toContain('o/demo#4: the posted findings could not be marked as sent — the session is gone');
  });

  it('posts before the bundle is written, so the bundle carries what went out', async () => {
    const order: string[] = [];
    await preparePr(snapshot(), posting(), deps({
      ...alerting('cf15e689'),
      listThreads: () => Promise.resolve([named()]),
      markPosted: () => { order.push('marked'); },
      exportBundle: ({ outPath }) => {
        order.push('exported');
        mkdirSync(dirname(outPath), { recursive: true });
        writeFileSync(outPath, '{"bundle":true}\n');
      },
    }));

    expect(order).toEqual(['marked', 'exported']);
  });
});

describe('the inbox JSON server', () => {
  it('answers /api/inbox with the current view', async () => {
    const store = new InboxStore(':memory:');
    store.observe({ ...snapshot(), headSha: 'aaa' }, true, 'now');
    store.markPrepared('o/demo#4', { headSha: 'aaa', bundlePath: '/b.json', worktreePath: '/wt', logPath: '/l', at: 'now', summary: null, alert: null, alertFindings: [] });
    const noOpenDeps = { baseRefOf: () => 'x', ensureServer: () => Promise.resolve(1), importBundle: () => {} };
    const server = startInboxServer(store, { ...config(), port: 0 }, () => {}, noOpenDeps);
    await new Promise(resolve => server.on('listening', resolve));
    const { port } = server.address() as { port: number };

    const res = await fetch(`http://127.0.0.1:${port}/api/inbox`);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.ready).toHaveLength(1);
    expect(body.ready[0].id).toBe('o/demo#4');

    const notFound = await fetch(`http://127.0.0.1:${port}/nope`);
    expect(notFound.status).toBe(404);

    server.close();
    store.close();
  });

  it('shapes a prepared row as ready and openable', () => {
    const store = new InboxStore(':memory:');
    store.observe({ ...snapshot(), headSha: 'aaa' }, true, 'now');
    store.markPrepared('o/demo#4', { headSha: 'aaa', bundlePath: '/b', worktreePath: '/wt', logPath: '/l', at: 'now', summary: null, alert: null, alertFindings: [] });
    const view = buildView(store, 'http://localhost:5390', 'now');
    expect(view.ready[0].openUrl).toBe('http://localhost:5390/open/o%2Fdemo%234');
    expect(view.ready[0].stale).toBe(false);
    store.close();
  });

  it('carries what the agent spent on a prepared review, and the pause, to the page', async () => {
    const store = new InboxStore(':memory:');
    store.observe({ ...snapshot(), headSha: 'aaa' }, true, 'now');
    store.markPrepared('o/demo#4', { headSha: 'aaa', bundlePath: '/b.json', worktreePath: '/wt', logPath: '/l', at: 'now', summary: '1 P1', alert: null, alertFindings: [] });
    store.recordRun({
      prId: 'o/demo#4', headSha: 'aaa', phase: 'prepare', model: 'claude-x',
      startedAt: new Date().toISOString(), endedAt: new Date().toISOString(), durationMs: 480_000,
      turns: 12, costUsd: 1.2, inputTokens: 30, outputTokens: 27_000, cacheReadTokens: 1_100_000,
      cacheWriteTokens: 76_000, outcome: 'prepared', note: null,
    });
    const until = new Date(Date.now() + 60_000).toISOString();
    store.pauseUntil(until);
    const noOpenDeps = { baseRefOf: () => 'x', ensureServer: () => Promise.resolve(1), importBundle: () => {} };
    const server = startInboxServer(store, { ...config(), port: 0 }, () => {}, noOpenDeps);
    await new Promise(resolve => server.on('listening', resolve));
    const { port } = server.address() as { port: number };

    const body = await (await fetch(`http://127.0.0.1:${port}/api/inbox`)).json();

    expect(body.ready[0].spend).toEqual({
      minutes: 8, costUsd: 1.2, detail: 'prepare · claude-x · 12 turns · out 27k · read 1.1M',
    });
    expect(body.runs.today).toEqual({ count: 1, minutes: 8, costUsd: 1.2 });
    expect(body.runs.week).toEqual({ count: 1, minutes: 8, costUsd: 1.2 });
    expect(body.pausedUntil).toBe(until);

    server.close();
    store.close();
  });

  it('lists the checking pass beside the drafting one on the card\'s hover', async () => {
    const store = new InboxStore(':memory:');
    store.observe({ ...snapshot(), headSha: 'aaa' }, true, 'now');
    store.markPrepared('o/demo#4', { headSha: 'aaa', bundlePath: '/b.json', worktreePath: '/wt', logPath: '/l', at: 'now', summary: '1 P1', alert: null, alertFindings: [] });
    const base = {
      prId: 'o/demo#4', headSha: 'aaa', inputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0, note: null,
    };
    store.recordRun({
      ...base, phase: 'prepare', model: 'claude-draft', startedAt: '2026-09-07T12:00:00.000Z',
      endedAt: '2026-09-07T12:08:00.000Z', durationMs: 480_000, turns: 12, costUsd: 1.2,
      outputTokens: 27_000, outcome: 'prepared',
    });
    store.recordRun({
      ...base, phase: 'validate', model: 'claude-check', startedAt: '2026-09-07T12:08:00.000Z',
      endedAt: '2026-09-07T12:11:00.000Z', durationMs: 180_000, turns: 4, costUsd: 0.8,
      outputTokens: 3000, outcome: 'validated',
    });

    const spend = buildView(store, 'http://localhost:5390', 'now').ready[0].spend;

    expect(spend).toEqual({
      minutes: 11,
      costUsd: 2,
      detail: 'prepare \u00b7 claude-draft \u00b7 12 turns \u00b7 out 27k \u00b7 read 0\nvalidate \u00b7 claude-check \u00b7 4 turns \u00b7 out 3k \u00b7 read 0',
    });
    store.close();
  });

  it('reviews a pinned head the pull request has moved past', async () => {
    // A second push, so the snapshot's head is no longer where the pull request points.
    const upstream = join(root, 'remotes', 'o', 'demo');
    writeFileSync(join(upstream, 'b.ts'), 'const b = 2;\n');
    git(upstream, ['add', '.']);
    git(upstream, ['commit', '-m', 'more']);
    git(upstream, ['update-ref', 'refs/pull/4/head', 'HEAD']);
    const moved = git(upstream, ['rev-parse', 'HEAD']);

    const result = await preparePr(snapshot(), config(), deps(), { pinHead: head });

    expect(result.kind).toBe('prepared');
    if (result.kind !== 'prepared') return;
    expect(result.headSha).toBe(head);
    expect(result.headSha).not.toBe(moved);
    expect(existsSync(join(result.worktree, 'b.ts'))).toBe(false);
    expect(result.bundlePath).toContain(head.slice(0, 12));
  });

  it('sets the filter aside for a bumped pull request', async () => {
    prompts = [];
    const withFilter = { ...config(), filter: 'Skip payments-focused PRs' };
    await preparePr(snapshot(), withFilter, deps());
    expect(prompts[0]).toContain('Skip payments-focused PRs');

    prompts = [];
    await preparePr(snapshot(), withFilter, deps(), { bumped: true });
    expect(prompts[0]).not.toContain('Skip payments-focused PRs');
  });

  it('reads the findings summary from the bundle it wrote and keeps the agent\'s alert', async () => {
    const result = await preparePr(snapshot(), config(), deps({
      runAgent: () => Promise.resolve({ stdout: 'reviewing\nALERT: touches auth\nPREPARED\n', timedOut: false }),
      exportBundle: ({ outPath }) => {
        mkdirSync(dirname(outPath), { recursive: true });
        writeFileSync(outPath, JSON.stringify({ threads: [
          { filePath: 'a.ts', status: 'open', comments: [{ body: 'P1: bad', kind: 'review' }] },
          { filePath: 'a.ts', status: 'open', comments: [{ body: 'P2: meh', kind: 'review' }] },
        ] }));
      },
    }));
    expect(result.kind).toBe('prepared');
    expect(result.kind === 'prepared' && result.summary).toBe('1 P1 \u00b7 1 P2');
    expect(result.kind === 'prepared' && result.alert).toBe('touches auth');
  });
});
