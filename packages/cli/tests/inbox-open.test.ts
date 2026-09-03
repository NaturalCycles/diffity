import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { request } from 'node:http';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { resolveDismiss, resolveOpen } from '../src/inbox/open.js';
import { openPreparedSession, baseRefOf, ensureServer, repoHash, serverArgs, type OpenSessionDeps } from '../src/inbox/open-session.js';
import { startInboxServer } from '../src/inbox/daemon.js';
import { InboxStore } from '../src/inbox/store.js';
import { readRegistry, registerInstance } from '../src/registry.js';
import type { PrSnapshot } from '@diffity/github';

const ENTRY = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist', 'index.js');

let root: string;

function snapshot(): PrSnapshot {
  return {
    owner: 'o', repo: 'r', number: 4, title: 'A change', url: 'https://github.com/o/r/pull/4',
    author: 'alice', isBot: false, isDraft: false, state: 'OPEN', headSha: 'aaa', baseRef: 'main',
    additions: 3, deletions: 1, changedFiles: 2, updatedAt: 'now',
  };
}

function preparedStore(): InboxStore {
  const store = new InboxStore(':memory:');
  store.observe(snapshot(), true, 'now');
  store.markPrepared('o/r#4', { headSha: 'aaa', bundlePath: '/b.json', worktreePath: '/wt', logPath: '/l', at: 'now' });
  return store;
}

beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'diffity-open-')); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

/** Whether the child is gone within a few seconds of being told to go. */
function exited(child: ChildProcess, ms = 3000): Promise<boolean> {
  return new Promise(resolve => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve(true);
      return;
    }
    const timer = setTimeout(() => resolve(false), ms);
    child.once('exit', () => { clearTimeout(timer); resolve(true); });
  });
}

/** A request with forged headers fetch() will not set, resolving to the status code. */
function rawStatus(port: number, method: string, path: string, headers: Record<string, string>): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path, method, headers }, res => {
      res.resume();
      resolve(res.statusCode ?? 0);
    });
    req.on('error', reject);
    req.end();
  });
}

describe('resolveOpen', () => {
  it('accepts a prepared pull request with a worktree and bundle', () => {
    const store = preparedStore();
    const r = resolveOpen(store, 'o/r#4');
    expect(r.ok).toBe(true);
    store.close();
  });

  it('refuses an unknown, a not-ready, or a worktree-less pull request', () => {
    const store = preparedStore();
    expect(resolveOpen(store, 'o/r#9')).toMatchObject({ ok: false, status: 404 });

    store.observe({ ...snapshot(), number: 5 }, true, 'now');
    store.setStatus('o/r#5', 'queued');
    expect(resolveOpen(store, 'o/r#5')).toMatchObject({ ok: false, status: 409 });
    store.close();
  });
});

describe('baseRefOf', () => {
  it('reads the base commit from a bundle and refuses one without it', () => {
    const withBase = join(root, 'a.json');
    writeFileSync(withBase, JSON.stringify({ baseSha: 'b'.repeat(40) }));
    expect(baseRefOf(withBase)).toBe('b'.repeat(40));

    const noBase = join(root, 'b.json');
    writeFileSync(noBase, JSON.stringify({ baseSha: null }));
    expect(() => baseRefOf(noBase)).toThrow(/no base commit/);
  });
});

describe('resolveDismiss', () => {
  it('accepts a prepared or queued pull request, refuses an unknown or an in-flight one', () => {
    const store = preparedStore();
    expect(resolveDismiss(store, 'o/r#4').ok).toBe(true);
    expect(resolveDismiss(store, 'o/r#9')).toMatchObject({ ok: false, status: 404 });

    store.observe({ ...snapshot(), number: 5 }, true, 'now');
    store.setStatus('o/r#5', 'preparing');
    expect(resolveDismiss(store, 'o/r#5')).toMatchObject({ ok: false, status: 409 });
    store.close();
  });
});

describe('openPreparedSession', () => {
  it('starts the session at the base and imports the bundle, returning its url', async () => {
    const calls: string[] = [];
    const deps: OpenSessionDeps = {
      baseRefOf: () => 'basesha',
      ensureServer: (wt, ref, pr) => { calls.push(`ensure ${wt} ${ref} #${pr}`); return Promise.resolve(5599); },
      importBundle: (wt, bundle) => { calls.push(`import ${wt} ${bundle}`); },
    };

    const result = await openPreparedSession('/wt', '/b.json', 4, deps);

    expect(result).toEqual({ url: 'http://localhost:5599/diff?ref=basesha', imported: true });
    expect(calls).toEqual(['ensure /wt basesha #4', 'import /wt /b.json']);
  });

  it('still opens the diff when the import fails, flagging it', async () => {
    const deps: OpenSessionDeps = {
      baseRefOf: () => 'basesha',
      ensureServer: () => Promise.resolve(5599),
      importBundle: () => { throw new Error('head moved'); },
    };
    const result = await openPreparedSession('/wt', '/b.json', 4, deps);
    expect(result).toEqual({ url: 'http://localhost:5599/diff?ref=basesha', imported: false, importError: 'head moved' });
  });
});

describe('serverArgs', () => {
  it('names the pull request when it has one, and only then', () => {
    expect(serverArgs('/e.js', '/wt', 'basesha', 14502))
      .toEqual(['/e.js', '--repo', '/wt', '--no-open', '--quiet', '--pr', '14502', 'basesha']);
    expect(serverArgs('/e.js', '/wt', 'work', undefined))
      .toEqual(['/e.js', '--repo', '/wt', '--no-open', '--quiet', 'work']);
  });
});

describe('the real ensureServer', () => {
  it('hashes a worktree the same way the diffity server it starts registers it', async () => {
    const prev = process.env.DIFFITY_DATA_DIR;
    process.env.DIFFITY_DATA_DIR = join(root, 'data');
    const repo = join(root, 'repo');
    execFileSync('git', ['init', '-b', 'main', repo], { stdio: 'pipe' });
    execFileSync('git', ['config', 'user.email', 't@t'], { cwd: repo, stdio: 'pipe' });
    execFileSync('git', ['config', 'user.name', 'T'], { cwd: repo, stdio: 'pipe' });
    writeFileSync(join(repo, 'a.ts'), 'const a = 1;\n');
    execFileSync('git', ['add', '.'], { cwd: repo, stdio: 'pipe' });
    execFileSync('git', ['commit', '-m', 'init'], { cwd: repo, stdio: 'pipe' });

    let port = 0;
    try {
      port = await ensureServer(process.execPath, ENTRY, repo, 'work', undefined, 20_000);
      // The entry the server registered must carry the hash open-session looks it up by.
      const entry = readRegistry().find(e => e.port === port);
      expect(entry).toBeDefined();
      expect(entry!.repoHash).toBe(repoHash(repo));
    } finally {
      const entry = readRegistry().find(e => e.port === port);
      if (entry) { try { process.kill(entry.pid, 'SIGKILL'); } catch { /* gone */ } }
      if (prev === undefined) delete process.env.DIFFITY_DATA_DIR; else process.env.DIFFITY_DATA_DIR = prev;
    }
  }, 30_000);

  it('throws when nothing registers before the deadline', async () => {
    const prev = process.env.DIFFITY_DATA_DIR;
    process.env.DIFFITY_DATA_DIR = join(root, 'empty-data');
    const idle = join(root, 'idle.mjs');
    writeFileSync(idle, 'setInterval(() => {}, 1000);\n');
    try {
      await expect(ensureServer(process.execPath, idle, join(root, 'wt'), 'work', undefined, 800)).rejects.toThrow(/did not start/);
    } finally {
      if (prev === undefined) delete process.env.DIFFITY_DATA_DIR; else process.env.DIFFITY_DATA_DIR = prev;
    }
  }, 10_000);
});

describe('the inbox server routes', () => {
  const stubOpen: OpenSessionDeps = {
    baseRefOf: () => 'basesha',
    ensureServer: () => Promise.resolve(7788),
    importBundle: () => {},
  };

  async function serve(store: InboxStore, logs: string[] = []) {
    const config = { pollMinutes: 5, port: 0, reposDir: root, worktreesDir: root, filter: '', prepare: ['x'], prepareTimeoutMinutes: 30, maxPrepared: 5 };
    const server = startInboxServer(store, config, m => logs.push(m), stubOpen);
    await new Promise(resolve => server.on('listening', resolve));
    const { port } = server.address() as { port: number };
    return { port, server };
  }

  it('serves the page at / and the view at /api/inbox', async () => {
    const store = preparedStore();
    const { port, server } = await serve(store);
    try {
      const page = await fetch(`http://127.0.0.1:${port}/`);
      expect(page.headers.get('content-type')).toContain('text/html');
      expect(await page.text()).toContain('diffity inbox');

      const api = await (await fetch(`http://127.0.0.1:${port}/api/inbox`)).json();
      expect(api.ready[0].id).toBe('o/r#4');
    } finally {
      server.close();
      store.close();
    }
  });

  it('redirects /open/<id> to the opened session, and 409s a not-ready one', async () => {
    const store = preparedStore();
    const { port, server } = await serve(store);
    try {
      const res = await fetch(`http://127.0.0.1:${port}/open/${encodeURIComponent('o/r#4')}`, { redirect: 'manual' });
      expect(res.status).toBe(302);
      expect(res.headers.get('location')).toBe('http://localhost:7788/diff?ref=basesha');

      store.observe({ ...snapshot(), number: 8 }, true, 'now');
      const notReady = await fetch(`http://127.0.0.1:${port}/open/${encodeURIComponent('o/r#8')}`, { redirect: 'manual' });
      expect(notReady.status).toBe(409);
    } finally {
      server.close();
      store.close();
    }
  });

  it('dismisses a pull request on POST /dismiss/<id>, reclaiming its worktree and hiding it', async () => {
    const store = preparedStore();
    const logs: string[] = [];
    const { port, server } = await serve(store, logs);
    try {
      const res = await fetch(`http://127.0.0.1:${port}/dismiss/${encodeURIComponent('o/r#4')}`, { method: 'POST' });
      expect(res.status).toBe(204);
      const pr = store.get('o/r#4')!;
      expect(pr.status).toBe('dismissed');
      expect(pr.statusReason).toBe('dismissed by the reviewer');
      expect(pr.worktreePath).toBeNull();
      expect(logs).toContain('dismissed o/r#4');

      const api = await (await fetch(`http://127.0.0.1:${port}/api/inbox`)).json();
      expect(api.ready).toEqual([]);
      expect(api.other).toEqual([]);

      const unknown = await fetch(`http://127.0.0.1:${port}/dismiss/${encodeURIComponent('o/r#9')}`, { method: 'POST' });
      expect(unknown.status).toBe(404);
    } finally {
      server.close();
      store.close();
    }
  });

  it('stops the session the reviewer opened on a dismissed worktree before removing it', async () => {
    const prev = process.env.DIFFITY_DATA_DIR;
    process.env.DIFFITY_DATA_DIR = join(root, 'data');
    const idle = join(root, 'idle.mjs');
    writeFileSync(idle, 'setInterval(() => {}, 1000);\n');
    const session = spawn(process.execPath, [idle], { stdio: 'ignore' });
    const store = preparedStore();
    const { port, server } = await serve(store);
    try {
      registerInstance({
        pid: session.pid!, port: 1, repoRoot: '/wt', repoHash: repoHash('/wt'), repoName: 'wt',
        ref: 'basesha', description: '', startedAt: new Date().toISOString(),
      });
      const res = await fetch(`http://127.0.0.1:${port}/dismiss/${encodeURIComponent('o/r#4')}`, { method: 'POST' });
      expect(res.status).toBe(204);
      expect(await exited(session)).toBe(true);
      expect(readRegistry().find(e => e.pid === session.pid)).toBeUndefined();
    } finally {
      try { session.kill('SIGKILL'); } catch { /* gone */ }
      server.close();
      store.close();
      if (prev === undefined) delete process.env.DIFFITY_DATA_DIR; else process.env.DIFFITY_DATA_DIR = prev;
    }
  });

  it('answers a malformed /open URL with 400 and keeps running', async () => {
    const store = preparedStore();
    const { port, server } = await serve(store);
    try {
      const bad = await fetch(`http://127.0.0.1:${port}/open/%`);
      expect(bad.status).toBe(400);
      // The daemon is still up and serving afterwards.
      const ok = await fetch(`http://127.0.0.1:${port}/api/inbox`);
      expect(ok.status).toBe(200);
    } finally {
      server.close();
      store.close();
    }
  });

  it('rejects a foreign Host header and a cross-site open', async () => {
    const store = preparedStore();
    const { port, server } = await serve(store);
    try {
      // fetch() forbids setting Host and Sec-Fetch-*, so a raw request is needed to forge them.
      const rebind = await rawStatus(port, 'GET', '/api/inbox', { Host: 'evil.example.com:1234' });
      expect(rebind).toBe(403);

      const driveBy = await rawStatus(port, 'GET', `/open/${encodeURIComponent('o/r#4')}`, {
        Host: `127.0.0.1:${port}`, 'Sec-Fetch-Site': 'cross-site',
      });
      expect(driveBy).toBe(403);

      const driveByDismiss = await rawStatus(port, 'POST', `/dismiss/${encodeURIComponent('o/r#4')}`, {
        Host: `127.0.0.1:${port}`, 'Sec-Fetch-Site': 'cross-site',
      });
      expect(driveByDismiss).toBe(403);
      expect(store.get('o/r#4')!.status).toBe('prepared');
    } finally {
      server.close();
      store.close();
    }
  });

  it('surfaces an import failure in the log but still redirects', async () => {
    const store = preparedStore();
    const logs: string[] = [];
    const failingOpen: OpenSessionDeps = {
      baseRefOf: () => 'basesha',
      ensureServer: () => Promise.resolve(7788),
      importBundle: () => { throw new Error('head moved'); },
    };
    const config = { pollMinutes: 5, port: 0, reposDir: root, worktreesDir: root, filter: '', prepare: ['x'], prepareTimeoutMinutes: 30, maxPrepared: 5 };
    const server = startInboxServer(store, config, m => logs.push(m), failingOpen);
    await new Promise(resolve => server.on('listening', resolve));
    const { port } = server.address() as { port: number };
    try {
      const res = await fetch(`http://127.0.0.1:${port}/open/${encodeURIComponent('o/r#4')}`, { redirect: 'manual' });
      expect(res.status).toBe(302);
      expect(logs.some(l => l.includes('did not import') && l.includes('head moved'))).toBe(true);
    } finally {
      server.close();
      store.close();
    }
  });
});
