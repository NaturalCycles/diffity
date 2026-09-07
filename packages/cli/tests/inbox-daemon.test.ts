import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runDaemon } from '../src/inbox/daemon.js';
import { InboxStore } from '../src/inbox/store.js';
import type { Forge } from '../src/inbox/tick.js';
import type { AgentConfig } from '../src/inbox/config.js';
import type { PrSnapshot } from '@diffity/github';

/** The built-in agent settings, fresh each call so a test cannot leak into the next. */
function agentConfig(): AgentConfig {
  return { model: null, effort: null, mcpAllow: [], extraArgs: [], maxBudgetUsd: null };
}

let root: string;
let origDataDir: string | undefined;

/** A forge that lists nothing, so a tick does no forge work and no preparation. */
const emptyForge: Forge = {
  viewerLogin: () => Promise.resolve('me'),
  searchReviewRequested: () => Promise.resolve([]),
  viewPr: () => Promise.resolve(null),
};

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
    filter: '', alertWhen: '', alertPaths: [], agent: agentConfig(), validate: { model: null, timeoutMinutes: 15, maxBudgetUsd: null },
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

  it('a bump posted while a tick is in flight gets another tick as soon as that one ends', async () => {
    const store = new InboxStore(join(root, 'inbox', 'inbox.sqlite'));
    const snap: PrSnapshot = {
      owner: 'o', repo: 'r', number: 1, title: 'T', url: 'https://github.com/o/r/pull/1', author: 'alice', isBot: false,
      isDraft: false, state: 'OPEN', headSha: 'aaa', baseRef: 'main', additions: 1, deletions: 0, changedFiles: 1,
      createdAt: 'now', updatedAt: 'now', checks: [], files: [],
    };
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
    };
    const handle = await runDaemon(store, config(6005), process.execPath, 'unused-entry', () => {}, { forge });
    try {
      await settle();
      expect(searches).toBe(1);
      const res = await fetch(`http://127.0.0.1:6005/prepare/${encodeURIComponent('o/r#1')}`, { method: 'POST' });
      expect(res.status).toBe(204);
      expect(store.get('o/r#1')!.bumpedAt).not.toBeNull();
      // Still the first tick: the bump did not start a second one underneath it.
      expect(searches).toBe(1);

      release();
      await settle();
      await settle();
      expect(searches).toBe(2);
      // The bump was served — the row was prepared (and failed for want of a clone) — and is spent.
      expect(store.get('o/r#1')!.bumpedAt).toBeNull();
    } finally {
      await handle.stop();
    }
  });

  it('polls but prepares nothing while paused, and takes the queue up once the pause has passed', async () => {
    const store = new InboxStore(join(root, 'inbox', 'inbox.sqlite'));
    const snap: PrSnapshot = {
      owner: 'o', repo: 'r', number: 1, title: 'T', url: 'https://github.com/o/r/pull/1', author: 'alice', isBot: false,
      isDraft: false, state: 'OPEN', headSha: 'aaa', baseRef: 'main', additions: 1, deletions: 0, changedFiles: 1,
      createdAt: 'now', updatedAt: 'now', checks: [], files: [],
    };
    store.observe(snap, true, 'now');
    store.pauseUntil(new Date(Date.now() + 60_000).toISOString());
    const forge: Forge = {
      viewerLogin: () => Promise.resolve('me'),
      searchReviewRequested: () => Promise.resolve([{ owner: 'o', repo: 'r', number: 1 }]),
      viewPr: () => Promise.resolve(snap),
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
