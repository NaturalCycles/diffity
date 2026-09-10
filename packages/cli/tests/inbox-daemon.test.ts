import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runDaemon } from '../src/inbox/daemon.js';
import { noneInflight } from '../src/inbox/runtime.js';
import { InboxStore } from '../src/inbox/store.js';
import type { Forge } from '../src/inbox/tick.js';
import type { AgentConfig } from '../src/inbox/config.js';
import type { PrepareResult } from '../src/inbox/prepare.js';
import type { PrSnapshot } from '@diffity/github';

/** The built-in agent settings, fresh each call so a test cannot leak into the next. */
function agentConfig(): AgentConfig {
  return { model: null, effort: null, mcpAllow: [], extraArgs: [], maxBudgetUsd: null };
}

let root: string;
let origDataDir: string | undefined;

/** What a forge answers when nothing is watched, so no test reaches a repository listing. */
const noTriage = {
  listOpenPrs: () => Promise.resolve([]),
  prDiff: () => Promise.resolve(''),
};

/** A forge that lists nothing, so a tick does no forge work and no preparation. */
const emptyForge: Forge = {
  viewerLogin: () => Promise.resolve('me'),
  searchReviewRequested: () => Promise.resolve([]),
  viewPr: () => Promise.resolve(null),
  ...noTriage,
};

function snapshot(number: number, additions: number): PrSnapshot {
  return {
    owner: 'o', repo: 'r', number, title: `T${number}`, body: '', url: `https://github.com/o/r/pull/${number}`,
    author: 'alice', isBot: false, isDraft: false, state: 'OPEN', headSha: 'aaa', baseRef: 'main',
    additions, deletions: 0, changedFiles: 1, createdAt: 'now', updatedAt: 'now', checks: [], files: [],
  };
}

/** A preparation that came to something, so a row it ran for reads as prepared. */
function preparedResult(snapshot: PrSnapshot): PrepareResult {
  return {
    kind: 'prepared', headSha: snapshot.headSha, bundlePath: '/b.json', worktree: '/wt', logPath: '/l.log',
    at: 'now', summary: '1 P2', alert: null, alertFindings: [], posted: null, validation: 'not-needed', validateRun: null,
    run: { startedAt: 'now', endedAt: 'now', stats: null },
  };
}

/** A live process whose pid can be seeded into a registry and checked for liveness. */
function spawnDummy(): number {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1e9)'], { stdio: 'ignore', detached: true });
  child.unref();
  return child.pid!;
}

function isAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

function seedRegistry(pid: number): void {
  const dir = join(root, 'inbox', 'data', 'o-r-1');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'registry.json'), JSON.stringify([{ pid, port: 6001 }]));
}

function config(port: number) {
  return {
    pollMinutes: 5, port, reposDir: join(root, 'repos'), worktreesDir: join(root, 'inbox', 'worktrees'),
    filter: '', skipTitles: [], alertWhen: '', alertPaths: [], postAlerts: false, postSeverities: ['P1', 'must-fix'], quietOnceCommented: false,
    postPrefix: '[not yet checked by human]', postFooter: '', agent: agentConfig(), validate: { model: null, timeoutMinutes: 15, maxBudgetUsd: null },
    triage: { repos: [], bodyPatterns: [], model: null, maxDiffKb: 150, maxBudgetUsd: 0.25 },
    waitForCi: false, prepareTimeoutMinutes: 30, maxPrepared: 5, live: true, liveTimeoutMinutes: 10,
  };
}

async function settle(): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, 150));
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'diffity-daemon-'));
  origDataDir = process.env.DIFFITY_DATA_DIR;
  process.env.DIFFITY_DATA_DIR = root;
});

afterEach(() => {
  if (origDataDir === undefined) delete process.env.DIFFITY_DATA_DIR;
  else process.env.DIFFITY_DATA_DIR = origDataDir;
  rmSync(root, { recursive: true, force: true });
});

describe('runDaemon singleton and reclaim ordering', () => {
  it('a single pass reclaims nothing, so a running daemon\'s server is spared', async () => {
    const pid = spawnDummy();
    seedRegistry(pid);
    try {
      const store = new InboxStore(join(root, 'inbox', 'inbox.sqlite'));
      const handle = await runDaemon(store, config(6002), process.execPath, 'unused-entry', () => {}, { once: true, forge: emptyForge });
      await handle.stop();

      expect(handle.port).toBeNull();
      expect(isAlive(pid)).toBe(true);
    } finally {
      try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ }
    }
  });

  it('the daemon reclaims a previous run\'s registered server after binding its port', async () => {
    const pid = spawnDummy();
    seedRegistry(pid);
    try {
      const store = new InboxStore(join(root, 'inbox', 'inbox.sqlite'));
      const handle = await runDaemon(store, config(6003), process.execPath, 'unused-entry', () => {}, { forge: emptyForge });
      await settle();

      expect(handle.port).toBe(6003);
      expect(isAlive(pid)).toBe(false);
      await handle.stop();
    } finally {
      try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ }
    }
  });

  it('watches the repositories the config names, and prepares what its rules flag', async () => {
    const store = new InboxStore(join(root, 'inbox', 'inbox.sqlite'));
    const watched = snapshot(9, 3);
    const listed: string[] = [];
    const forge: Forge = {
      viewerLogin: () => Promise.resolve('me'),
      searchReviewRequested: () => Promise.resolve([]),
      viewPr: () => Promise.resolve(watched),
      listOpenPrs: repo => {
        listed.push(repo);
        return Promise.resolve([{
          owner: 'o', repo: 'r', number: 9, title: 'T9', body: '* platform - risk level: high',
          author: 'alice', isBot: false, url: watched.url, updatedAt: 'now',
        }]);
      },
      prDiff: () => Promise.resolve(''),
    };
    const watching = {
      ...config(6005),
      triage: { repos: ['o/r'], bodyPatterns: ['^\\* platform - risk level: high$'], model: null, maxDiffKb: 150, maxBudgetUsd: 0.25 },
    };
    const handle = await runDaemon(store, watching, process.execPath, 'unused-entry', () => {}, {
      once: true, forge, prepare: snap => Promise.resolve(preparedResult(snap)),
    });
    await handle.stop();

    expect(listed).toEqual(['o/r']);
    const reopened = new InboxStore(join(root, 'inbox', 'inbox.sqlite'));
    expect(reopened.get('o/r#9')).toMatchObject({ status: 'prepared', triageReason: '* platform - risk level: high' });
    expect(reopened.triagePass()).toMatchObject({ watched: 1, quiet: 0 });
    reopened.close();
  });

  it('answers /api/inbox once bound', async () => {
    const store = new InboxStore(join(root, 'inbox', 'inbox.sqlite'));
    const handle = await runDaemon(store, config(6004), process.execPath, 'unused-entry', () => {}, { forge: emptyForge });
    try {
      await settle();
      const res = await fetch('http://127.0.0.1:6004/api/inbox');
      const body = await res.json();
      expect(res.status).toBe(200);
      expect(body).toHaveProperty('ready');
      // The first tick has run by now: not ticking, and it says when it polled.
      expect(body.ticking).toBe(false);
      expect(typeof body.lastPollAt).toBe('string');
    } finally {
      await handle.stop();
    }
  });

  it('a \u27f3 pressed while a tick is in flight gets another tick as soon as that one ends', async () => {
    const store = new InboxStore(join(root, 'inbox', 'inbox.sqlite'));
    const snap = snapshot(1, 1);
    store.observe(snap, true, 'now');
    let searches = 0;
    let release: () => void = () => {};
    const firstView = new Promise<void>(resolve => { release = resolve; });
    // The first tick is held open inside the forge; later ones pass straight through. Preparation
    // itself fails at once — there is no clone under reposDir — so a tick is only as long as the hold.
    const forge: Forge = {
      viewerLogin: () => Promise.resolve('me'),
      searchReviewRequested: () => { searches++; return Promise.resolve([{ owner: 'o', repo: 'r', number: 1 }]); },
      viewPr: async () => { await firstView; return snap; },
      ...noTriage,
    };
    const handle = await runDaemon(store, config(6005), process.execPath, 'unused-entry', () => {}, { forge });
    try {
      await settle();
      expect(searches).toBe(1);
      expect((await fetch('http://127.0.0.1:6005/api/tick', { method: 'POST' })).status).toBe(204);
      // Still the first tick: the ⟳ did not start a second one underneath it.
      expect(searches).toBe(1);

      release();
      await settle();
      await settle();
      expect(searches).toBe(2);
    } finally {
      await handle.stop();
    }
  });

  it('prepares a bumped pull request at once, beside the one the tick is already on', async () => {
    const store = new InboxStore(join(root, 'inbox', 'inbox.sqlite'));
    const first = snapshot(1, 10);
    const second = snapshot(2, 20);
    store.observe(first, true, 'now');
    store.observe(second, true, 'now');
    const forge: Forge = {
      viewerLogin: () => Promise.resolve('me'),
      searchReviewRequested: () => Promise.resolve([{ owner: 'o', repo: 'r', number: 1 }, { owner: 'o', repo: 'r', number: 2 }]),
      viewPr: ref => Promise.resolve(ref.number === 1 ? first : second),
      ...noTriage,
    };
    // The tick's own preparation of #1 is held open; the bumped one must not wait for it.
    const started: number[] = [];
    let release: () => void = () => {};
    const held = new Promise<void>(resolve => { release = resolve; });
    const prepare = async (snap: PrSnapshot): Promise<PrepareResult> => {
      started.push(snap.number);
      if (snap.number === 1) {
        await held;
      }
      return preparedResult(snap);
    };
    const handle = await runDaemon(store, config(6007), process.execPath, 'unused-entry', () => {}, { forge, prepare });
    try {
      await settle();
      expect(started).toEqual([1]);
      expect(store.get('o/r#1')!.status).toBe('preparing');

      const res = await fetch(`http://127.0.0.1:6007/prepare/${encodeURIComponent('o/r#2')}`, { method: 'POST' });
      expect(res.status).toBe(204);
      await settle();

      // #2 was prepared while #1 was still going, and the page has it as preparing meanwhile.
      expect(started).toEqual([1, 2]);
      expect(store.get('o/r#2')!.status).toBe('prepared');
      expect(store.get('o/r#1')!.status).toBe('preparing');

      release();
      await settle();
      await settle();
      // The tick finishes #1 and does not hand #2 a second agent.
      expect(started).toEqual([1, 2]);
      expect(store.get('o/r#1')!.status).toBe('prepared');
    } finally {
      release();
      await settle();
      await handle.stop();
    }
  });

  it('stops every preparation still running when it shuts down', async () => {
    const store = new InboxStore(join(root, 'inbox', 'inbox.sqlite'));
    const inflight = noneInflight();
    const handle = await runDaemon(store, config(6008), process.execPath, 'unused-entry', () => {}, { forge: emptyForge, inflight });
    await settle();
    // What two prepares running at once leave behind them: a server and an agent each.
    const stopped: string[] = [];
    for (const name of ['first server', 'first agent', 'second server', 'second agent']) {
      inflight.stops.add(() => stopped.push(name));
    }

    await handle.stop();

    expect(stopped).toEqual(['first server', 'first agent', 'second server', 'second agent']);
    expect(inflight.stops.size).toBe(4);
  });

  it('polls but prepares nothing while paused, and takes the queue up once the pause has passed', async () => {
    const store = new InboxStore(join(root, 'inbox', 'inbox.sqlite'));
    const snap: PrSnapshot = {
      owner: 'o', repo: 'r', number: 1, title: 'T', body: '', url: 'https://github.com/o/r/pull/1', author: 'alice', isBot: false,
      isDraft: false, state: 'OPEN', headSha: 'aaa', baseRef: 'main', additions: 1, deletions: 0, changedFiles: 1,
      createdAt: 'now', updatedAt: 'now', checks: [], files: [],
    };
    store.observe(snap, true, 'now');
    store.pauseUntil(new Date(Date.now() + 60_000).toISOString());
    const forge: Forge = {
      viewerLogin: () => Promise.resolve('me'),
      searchReviewRequested: () => Promise.resolve([{ owner: 'o', repo: 'r', number: 1 }]),
      viewPr: () => Promise.resolve(snap),
      ...noTriage,
    };
    const handle = await runDaemon(store, config(6006), process.execPath, 'unused-entry', () => {}, { forge });
    try {
      await settle();
      const paused = await (await fetch('http://127.0.0.1:6006/api/inbox')).json();
      expect(paused.pausedUntil).not.toBeNull();
      expect(store.get('o/r#1')!.status).toBe('queued');

      // The reset time passes: the next tick prepares it (and fails, for want of a clone).
      store.pauseUntil(new Date(Date.now() - 1000).toISOString());
      expect((await fetch('http://127.0.0.1:6006/api/tick', { method: 'POST' })).status).toBe(204);
      await settle();
      await settle();

      expect(store.get('o/r#1')!.status).toBe('failed');
      const resumed = await (await fetch('http://127.0.0.1:6006/api/inbox')).json();
      expect(resumed.pausedUntil).toBeNull();
    } finally {
      await handle.stop();
    }
  });
});
