import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { resolveOpen } from '../src/inbox/open.js';
import { openPreparedSession, baseRefOf, type OpenSessionDeps } from '../src/inbox/open-session.js';
import { startInboxServer } from '../src/inbox/daemon.js';
import { InboxStore } from '../src/inbox/store.js';
import type { PrSnapshot } from '@diffity/github';

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

describe('openPreparedSession', () => {
  it('starts the session at the base and imports the bundle, returning its url', async () => {
    const calls: string[] = [];
    const deps: OpenSessionDeps = {
      baseRefOf: () => 'basesha',
      ensureServer: (wt, ref) => { calls.push(`ensure ${wt} ${ref}`); return Promise.resolve(5599); },
      importBundle: (wt, bundle) => { calls.push(`import ${wt} ${bundle}`); },
    };

    const result = await openPreparedSession('/wt', '/b.json', deps);

    expect(result).toEqual({ url: 'http://localhost:5599/', imported: true });
    expect(calls).toEqual(['ensure /wt basesha', 'import /wt /b.json']);
  });

  it('still opens the diff when the import fails, flagging it', async () => {
    const deps: OpenSessionDeps = {
      baseRefOf: () => 'basesha',
      ensureServer: () => Promise.resolve(5599),
      importBundle: () => { throw new Error('head moved'); },
    };
    const result = await openPreparedSession('/wt', '/b.json', deps);
    expect(result).toEqual({ url: 'http://localhost:5599/', imported: false });
  });
});

describe('the inbox server routes', () => {
  const stubOpen: OpenSessionDeps = {
    baseRefOf: () => 'basesha',
    ensureServer: () => Promise.resolve(7788),
    importBundle: () => {},
  };

  async function serve(store: InboxStore) {
    const config = { pollMinutes: 5, port: 0, reposDir: root, worktreesDir: root, filter: '', prepare: ['x'], prepareTimeoutMinutes: 30 };
    const server = startInboxServer(store, config, () => {}, stubOpen);
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
      expect(res.headers.get('location')).toBe('http://localhost:7788/');

      store.observe({ ...snapshot(), number: 8 }, true, 'now');
      const notReady = await fetch(`http://127.0.0.1:${port}/open/${encodeURIComponent('o/r#8')}`, { redirect: 'manual' });
      expect(notReady.status).toBe(409);
    } finally {
      server.close();
      store.close();
    }
  });
});
