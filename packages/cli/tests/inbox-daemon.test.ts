import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runDaemon } from '../src/inbox/daemon.js';
import { InboxStore } from '../src/inbox/store.js';
import type { Forge } from '../src/inbox/tick.js';

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
    filter: '', prepare: ['unused'], prepareTimeoutMinutes: 30, maxPrepared: 5, live: true, liveTimeoutMinutes: 10,
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
      const res = await fetch('http://127.0.0.1:6004/api/inbox');
      const body = await res.json();
      expect(res.status).toBe(200);
      expect(body).toHaveProperty('ready');
    } finally {
      await handle.stop();
    }
  });
});
