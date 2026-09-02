import { createServer, type Server } from 'node:http';
import { getViewerLogin, searchReviewRequested, viewPr } from '@diffity/github';
import type { InboxConfig } from './config.js';
import { preparePr, type PrepareDeps } from './prepare.js';
import { realPrepareDeps } from './runtime.js';
import { removeWorktree, cloneDir } from './worktree.js';
import { InboxStore } from './store.js';
import { runTick, type Forge } from './tick.js';
import { buildView } from './view.js';

export const realForge: Forge = {
  viewerLogin: getViewerLogin,
  searchReviewRequested,
  viewPr,
};

export interface DaemonHandle {
  port: number;
  stop(): Promise<void>;
}

/**
 * Runs the inbox: a poll every `pollMinutes` and a small JSON server the surface reads. The first
 * tick runs at once so a fresh start is not blank for five minutes.
 */
export async function runDaemon(
  store: InboxStore,
  config: InboxConfig,
  nodePath: string,
  entry: string,
  log: (message: string) => void,
): Promise<DaemonHandle> {
  const prepareDeps: PrepareDeps = realPrepareDeps(nodePath, entry);
  const deps = {
    forge: realForge,
    prepare: (snapshot: Parameters<typeof preparePr>[0]) => preparePr(snapshot, config, prepareDeps),
    removeWorktree: (worktree: string, repo: string) => removeWorktree(cloneDir(config.reposDir, repo), worktree),
    log,
    now: () => new Date().toISOString(),
  };

  let ticking = false;
  const tick = async () => {
    if (ticking) {
      return;
    }
    ticking = true;
    try {
      await runTick(store, deps);
    } catch (err) {
      log(`tick failed: ${err instanceof Error ? err.message : err}`);
    } finally {
      ticking = false;
    }
  };

  const server = startInboxServer(store, config);
  await tick();
  const timer = setInterval(tick, config.pollMinutes * 60_000);

  return {
    port: config.port,
    stop: () => new Promise<void>(resolve => {
      clearInterval(timer);
      server.close(() => resolve());
      store.close();
    }),
  };
}

export function startInboxServer(store: InboxStore, config: InboxConfig): Server {
  const server = createServer((req, res) => {
    const openBase = `http://localhost:${config.port}`;
    if (req.method === 'GET' && (req.url === '/api/inbox' || req.url === '/api/inbox/')) {
      const view = buildView(store, openBase, new Date().toISOString());
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(view));
      return;
    }
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'not found' }));
  });
  // Loopback only: the inbox surfaces the reviewer's pull requests and opens their local sessions.
  server.listen(config.port, '127.0.0.1');
  return server;
}
