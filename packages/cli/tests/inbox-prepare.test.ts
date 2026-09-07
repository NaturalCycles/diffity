import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { preparePr, type PrepareDeps } from '../src/inbox/prepare.js';
import { worktreePath } from '../src/inbox/worktree.js';
import { startInboxServer } from '../src/inbox/daemon.js';
import { InboxStore } from '../src/inbox/store.js';
import { buildView } from '../src/inbox/view.js';
import type { AgentConfig, InboxConfig } from '../src/inbox/config.js';
import type { PrSnapshot } from '@diffity/github';

/** The built-in agent settings, fresh each call so a test cannot leak into the next. */
function agentConfig(): AgentConfig {
  return { model: null, effort: null, mcpAllow: [], extraArgs: [], maxBudgetUsd: null };
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
    owner: 'o', repo: 'demo', number: 4, title: 'A change', url: 'https://github.com/o/demo/pull/4',
    author: 'alice', isBot: false, isDraft: false, state: 'OPEN', headSha: head, baseRef: 'main',
    additions: 1, deletions: 0, changedFiles: 1, createdAt: 'now', updatedAt: 'now', checks: [], files: [],
  };
}

function config(): InboxConfig {
  return {
    pollMinutes: 5, port: 0, reposDir, worktreesDir, filter: '', alertWhen: '', alertPaths: [],
    agent: agentConfig(), waitForCi: false, prepareTimeoutMinutes: 30, maxPrepared: 5, live: true, liveTimeoutMinutes: 10,
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

let prompts: string[] = [];
let argvs: string[][] = [];

function deps(over: Partial<PrepareDeps> = {}): PrepareDeps {
  return {
    startServer: () => Promise.resolve({ port: 5555, stop: () => {} }),
    agentArgv: () => ['claude', '-p', '--output-format', 'json'],
    runAgent: ({ cwd, prompt, argv }) => {
      prompts.push(prompt);
      argvs.push(argv);
      // The worktree exists and holds the checked-out file by the time the agent runs.
      expect(existsSync(join(cwd, 'a.ts'))).toBe(true);
      return Promise.resolve({ stdout: 'reviewing\nPREPARED\n', timedOut: false });
    },
    exportBundle: ({ outPath }) => {
      mkdirSync(dirname(outPath), { recursive: true });
      writeFileSync(outPath, '{"bundle":true}\n');
    },
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

  it('always stops the diffity server, even on a failure', async () => {
    let stopped = 0;
    await preparePr(snapshot(), config(), deps({
      startServer: () => Promise.resolve({ port: 1, stop: () => { stopped++; } }),
      exportBundle: () => { throw new Error('disk full'); },
    }));
    expect(stopped).toBe(1);
  });
});

describe('the inbox JSON server', () => {
  it('answers /api/inbox with the current view', async () => {
    const store = new InboxStore(':memory:');
    store.observe({ ...snapshot(), headSha: 'aaa' }, true, 'now');
    store.markPrepared('o/demo#4', { headSha: 'aaa', bundlePath: '/b.json', worktreePath: '/wt', logPath: '/l', at: 'now', summary: null, alert: null });
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
    store.markPrepared('o/demo#4', { headSha: 'aaa', bundlePath: '/b', worktreePath: '/wt', logPath: '/l', at: 'now', summary: null, alert: null });
    const view = buildView(store, 'http://localhost:5390', 'now');
    expect(view.ready[0].openUrl).toBe('http://localhost:5390/open/o%2Fdemo%234');
    expect(view.ready[0].stale).toBe(false);
    store.close();
  });

  it('carries what the agent spent on a prepared review, and the pause, to the page', async () => {
    const store = new InboxStore(':memory:');
    store.observe({ ...snapshot(), headSha: 'aaa' }, true, 'now');
    store.markPrepared('o/demo#4', { headSha: 'aaa', bundlePath: '/b.json', worktreePath: '/wt', logPath: '/l', at: 'now', summary: '1 P1', alert: null });
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
          { filePath: 'a.ts', comments: [{ body: 'P1: bad', kind: 'review' }] },
          { filePath: 'a.ts', comments: [{ body: 'P2: meh', kind: 'review' }] },
        ] }));
      },
    }));
    expect(result.kind).toBe('prepared');
    expect(result.kind === 'prepared' && result.summary).toBe('1 P1 \u00b7 1 P2');
    expect(result.kind === 'prepared' && result.alert).toBe('touches auth');
  });
});
