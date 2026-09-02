import { createServer, type Server } from 'node:http';
import { existsSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { basename, join } from 'node:path';
import { getViewerLogin, searchReviewRequested, viewPr } from '@diffity/github';
import type { InboxConfig } from './config.js';
import { inboxDir } from './paths.js';
import { preparePr, type PrepareDeps } from './prepare.js';
import { realPrepareDeps, type Inflight } from './runtime.js';
import { removeWorktree, cloneDir } from './worktree.js';
import { InboxStore } from './store.js';
import { runTick, type Forge } from './tick.js';
import { buildView } from './view.js';

const realForge: Forge = {
  viewerLogin: getViewerLogin,
  searchReviewRequested,
  viewPr,
};

/** Each pull request's diffity data lives apart, so a prepared session never mixes with another. */
export function inboxDataDir(worktree: string): string {
  return join(inboxDir(), 'data', basename(worktree));
}

export interface DaemonHandle {
  port: number | null;
  stop(): Promise<void>;
}

export interface DaemonOptions {
  /** A single pass then stop, with no HTTP server bound. */
  once?: boolean;
}

/**
 * Runs the inbox: a poll every `pollMinutes` and (unless `once`) a small JSON server the surface
 * reads. Returns before the first tick so the caller can arm its signal handlers first; the first
 * tick is kicked off immediately after, so a fresh start is not blank for a whole interval.
 */
export async function runDaemon(
  store: InboxStore,
  config: InboxConfig,
  nodePath: string,
  entry: string,
  log: (message: string) => void,
  options: DaemonOptions = {},
): Promise<DaemonHandle> {
  let stopping = false;
  let ticking = false;

  const inflight: Inflight = {};
  const prepareDeps: PrepareDeps = realPrepareDeps(nodePath, entry, inboxDataDir, inflight);
  const deps = {
    forge: realForge,
    prepare: (snapshot: Parameters<typeof preparePr>[0]) => preparePr(snapshot, config, prepareDeps),
    removeWorktree: (worktree: string, repo: string) => removeWorktree(cloneDir(config.reposDir, repo), worktree),
    log,
    now: () => new Date().toISOString(),
    shouldContinue: () => !stopping,
  };

  const tick = async () => {
    if (ticking || stopping) {
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

  if (options.once) {
    // No port to acquire and no other daemon to be, so no reclaim: a single pass must not disturb
    // a daemon that is already running and may be mid-prepare.
    await tick();
    store.close();
    return { port: null, stop: () => Promise.resolve() };
  }

  // Bind the port first: it is the daemon's singleton lock, so a second daemon exits here (via the
  // server's error handler) before it can reclaim and kill the first one's in-flight servers.
  const server = await bindInboxServer(store, config, log);
  reclaimLeftoverServers(log);
  const timer = setInterval(() => void tick(), config.pollMinutes * 60_000);
  void tick();

  return {
    port: config.port,
    stop: () => new Promise<void>(resolve => {
      stopping = true;
      clearInterval(timer);
      // Kill whatever a prepare has running right now — the detached diffity server and the agent
      // and its group — so nothing outlives the daemon.
      inflight.agentKill?.();
      inflight.serverStop?.();
      server.close(() => {
        store.close();
        resolve();
      });
    }),
  };
}

/**
 * On startup, kill any diffity servers a previous run left registered under the inbox's data
 * directories — a crash mid-prepare cannot stop them itself — and clear those registries.
 */
function reclaimLeftoverServers(log: (message: string) => void): void {
  const dataRoot = join(inboxDir(), 'data');
  if (!existsSync(dataRoot)) {
    return;
  }
  let killed = 0;
  for (const name of readdirSync(dataRoot)) {
    const registry = join(dataRoot, name, 'registry.json');
    if (!existsSync(registry)) {
      continue;
    }
    try {
      const rows = JSON.parse(readFileSync(registry, 'utf-8')) as { pid: number }[];
      for (const row of rows) {
        try { process.kill(row.pid, 'SIGTERM'); killed++; } catch { /* already gone */ }
      }
    } catch { /* unreadable registry, nothing to reclaim */ }
    rmSync(registry, { force: true });
  }
  if (killed > 0) {
    log(`reclaimed ${killed} diffity server(s) left by a previous run`);
  }
}

export function startInboxServer(store: InboxStore, config: InboxConfig, log: (message: string) => void): Server {
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
  server.on('error', err => {
    const code = (err as NodeJS.ErrnoException).code;
    log(code === 'EADDRINUSE'
      ? `port ${config.port} is already in use — is another diffity inbox running? Set a different "port" in the config.`
      : `inbox server error: ${err.message}`);
    process.exit(1);
  });
  // Loopback only: the inbox surfaces the reviewer's pull requests and opens their local sessions.
  server.listen(config.port, '127.0.0.1');
  return server;
}

/** Resolves once the port is held; a clash exits through the server's own error handler first. */
function bindInboxServer(store: InboxStore, config: InboxConfig, log: (message: string) => void): Promise<Server> {
  const server = startInboxServer(store, config, log);
  return new Promise(resolve => server.once('listening', () => resolve(server)));
}
