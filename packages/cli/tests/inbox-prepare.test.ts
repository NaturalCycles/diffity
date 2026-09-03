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
import type { InboxConfig } from '../src/inbox/config.js';
import type { PrSnapshot } from '@diffity/github';

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
    additions: 1, deletions: 0, changedFiles: 1, updatedAt: 'now',
  };
}

function config(): InboxConfig {
  return {
    pollMinutes: 5, port: 0, reposDir, worktreesDir, filter: '',
    prepare: ['unused'], prepareTimeoutMinutes: 30, maxPrepared: 5,
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

function deps(over: Partial<PrepareDeps> = {}): PrepareDeps {
  return {
    startServer: () => Promise.resolve({ port: 5555, stop: () => {} }),
    runAgent: ({ cwd }) => {
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
  it('cuts a worktree, runs the agent, exports a bundle, and keeps the worktree', async () => {
    const result = await preparePr(snapshot(), config(), deps());

    expect(result.kind).toBe('prepared');
    if (result.kind !== 'prepared') return;
    expect(existsSync(result.worktree)).toBe(true);
    expect(readFileSync(result.bundlePath, 'utf-8')).toContain('bundle');
    expect(result.headSha).toBe(snapshot().headSha);
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
    expect(result.reason).toContain('No local clone');
  });

  it('fails when the agent times out, without a leftover worktree', async () => {
    const dest = worktreePath(worktreesDir, snapshot());
    const result = await preparePr(snapshot(), config(), deps({
      runAgent: () => Promise.resolve({ stdout: '', timedOut: true }),
    }));
    expect(result.kind).toBe('failed');
    if (result.kind !== 'failed') return;
    expect(result.reason).toContain('did not finish');
    expect(existsSync(dest)).toBe(false);
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
    store.markPrepared('o/demo#4', { headSha: 'aaa', bundlePath: '/b.json', worktreePath: '/wt', logPath: '/l', at: 'now' });
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
    store.markPrepared('o/demo#4', { headSha: 'aaa', bundlePath: '/b', worktreePath: '/wt', logPath: '/l', at: 'now' });
    const view = buildView(store, 'http://localhost:5390', 'now');
    expect(view.ready[0].openUrl).toBe('http://localhost:5390/open/o%2Fdemo%234');
    expect(view.ready[0].stale).toBe(false);
    store.close();
  });
});
