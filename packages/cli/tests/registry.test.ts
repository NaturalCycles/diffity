import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync, writeFileSync, utimesSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { RegistryEntry } from '../src/registry.js';

let root: string;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'diffity-registry-'));
  process.env.DIFFITY_DATA_DIR = root;
});

afterAll(() => {
  delete process.env.DIFFITY_DATA_DIR;
  rmSync(root, { recursive: true, force: true });
});

function entry(over: Partial<RegistryEntry> = {}): RegistryEntry {
  return {
    pid: process.pid,
    port: 5391,
    repoRoot: '/tmp/repo',
    repoHash: 'abc123',
    repoName: 'repo',
    ref: 'work',
    description: 'test',
    startedAt: new Date().toISOString(),
    ...over,
  };
}

/** A pid that certainly lived and certainly does not any more. */
function deadPid(): number {
  const child = spawnSync('true');
  return child.pid!;
}

describe('where the registry lives', () => {
  it('honors DIFFITY_DATA_DIR, so a test never writes into the real one', async () => {
    const { registerInstance, readRegistry, deregisterInstance } = await import('../src/registry.js');

    registerInstance(entry());
    expect(existsSync(join(root, 'registry.json'))).toBe(true);
    expect(readRegistry().some(e => e.pid === process.pid)).toBe(true);
    deregisterInstance(process.pid);
  });
});

describe('a pid that came back as somebody else', () => {
  it('an entry whose process began after it was written is stale, alive pid or not', async () => {
    const { entryIsAlive } = await import('../src/registry.js');

    // This very process began long after 2001 — if its pid were in a 2001 entry, it is reuse.
    expect(entryIsAlive(entry({ startedAt: '2001-01-01T00:00:00.000Z' }))).toBe(false);
    expect(entryIsAlive(entry({ startedAt: new Date().toISOString() }))).toBe(true);
    expect(entryIsAlive(entry({ pid: deadPid() }))).toBe(false);
    // An unreadable stamp cannot prove reuse, so the alive pid keeps the entry.
    expect(entryIsAlive(entry({ startedAt: 'garbage' }))).toBe(true);
  });

  it('reading the registry drops it', async () => {
    const { registerInstance, readRegistry, deregisterInstance } = await import('../src/registry.js');

    registerInstance(entry({ startedAt: '2001-01-01T00:00:00.000Z' }));
    expect(readRegistry().some(e => e.pid === process.pid)).toBe(false);
    deregisterInstance(process.pid);
  });

  it('killInstance leaves the reused pid alone and drops the entry', async () => {
    const { registerInstance, killInstance, readRegistry } = await import('../src/registry.js');

    // Were killInstance to signal anyway, it would SIGTERM this very test run.
    registerInstance(entry({ startedAt: '2001-01-01T00:00:00.000Z' }));
    killInstance(entry({ startedAt: '2001-01-01T00:00:00.000Z' }));

    expect(readRegistry().some(e => e.pid === process.pid)).toBe(false);
  });
});

describe('the registry lock', () => {
  it('a stale lock is broken instead of waited out', async () => {
    const { readRegistry } = await import('../src/registry.js');

    const lock = join(root, 'registry.lock');
    writeFileSync(lock, '99999');
    const old = new Date(Date.now() - 60_000);
    utimesSync(lock, old, old);

    const before = Date.now();
    readRegistry();
    expect(Date.now() - before).toBeLessThan(1000);
  });

  it('a held lock is waited on without burning the cpu, then broken', async () => {
    const { readRegistry } = await import('../src/registry.js');

    // Fresh, so it is not stale: the loop has to wait the timeout out before breaking it.
    // Waiting costs ~3s wall clock but near-zero cpu when the loop sleeps; a busy-wait
    // burns a full core for the same three seconds.
    const lock = join(root, 'registry.lock');
    writeFileSync(lock, '99999');

    const cpuBefore = process.cpuUsage();
    const before = Date.now();
    try {
      readRegistry();
    } finally {
      rmSync(lock, { force: true });
    }
    const wall = Date.now() - before;
    const cpu = process.cpuUsage(cpuBefore);

    expect(wall).toBeGreaterThanOrEqual(2500);
    expect((cpu.user + cpu.system) / 1000).toBeLessThan(wall / 2);
  });
});
