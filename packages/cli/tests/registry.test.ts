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

describe('findServingInstance', () => {
  async function serveInfo(root: string): Promise<{ port: number; close(): void }> {
    const { createServer } = await import('node:http');
    const server = createServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ name: 'x', branch: 'main', root }));
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', () => resolve()));
    const { port } = server.address() as { port: number };
    return { port, close: () => server.close() };
  }

  it('trusts an alive entry whose server names that root', async () => {
    const { registerInstance, findServingInstance, deregisterInstance } = await import('../src/registry.js');
    const info = await serveInfo('/tmp/repo');
    registerInstance(entry({ port: info.port, repoHash: 'serving1' }));
    try {
      expect((await findServingInstance('serving1', '/tmp/repo'))?.port).toBe(info.port);
    } finally {
      info.close();
      deregisterInstance(process.pid);
    }
  });

  it('drops an entry whose port another server has taken', async () => {
    const { registerInstance, findServingInstance, readRegistry } = await import('../src/registry.js');
    const info = await serveInfo('/tmp/somebody-else');
    registerInstance(entry({ port: info.port, repoHash: 'serving2' }));
    try {
      expect(await findServingInstance('serving2', '/tmp/repo')).toBeNull();
      expect(readRegistry().find(e => e.repoHash === 'serving2')).toBeUndefined();
    } finally {
      info.close();
    }
  });

  it('keeps an alive entry whose server did not answer, and does not reuse it', async () => {
    const { registerInstance, findServingInstance, readRegistry, deregisterInstance } = await import('../src/registry.js');
    const { createServer } = await import('node:http');
    // A port that was listening and is not any more: the server is busy or bound elsewhere, not gone.
    const closed = createServer(() => {});
    await new Promise<void>(resolve => closed.listen(0, '127.0.0.1', () => resolve()));
    const { port } = closed.address() as { port: number };
    await new Promise<void>(resolve => closed.close(() => resolve()));
    registerInstance(entry({ port, repoHash: 'serving4' }));
    try {
      expect(await findServingInstance('serving4', '/tmp/repo')).toBeNull();
      expect(readRegistry().find(e => e.repoHash === 'serving4')).toBeDefined();
    } finally {
      deregisterInstance(process.pid);
    }
  });

  it('drops an entry whose process is gone', async () => {
    const { registerInstance, findServingInstance, readRegistry } = await import('../src/registry.js');
    registerInstance(entry({ pid: deadPid(), port: 1, repoHash: 'serving3' }));
    expect(await findServingInstance('serving3', '/tmp/repo')).toBeNull();
    expect(readRegistry().find(e => e.repoHash === 'serving3')).toBeUndefined();
  });
});
});
