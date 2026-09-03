import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { existsSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { basename, join } from 'node:path';
import { getViewerLogin, searchReviewRequested, viewPr } from '@diffity/github';
import type { InboxConfig } from './config.js';
import { inboxDir } from './paths.js';
import { preparePr, type PrepareDeps } from './prepare.js';
import { realPrepareDeps, type Inflight } from './runtime.js';
import { removeWorktree, cloneDir } from './worktree.js';
import { findInstanceForRepo, killInstance } from '../registry.js';
import { repoHash } from './open-session.js';
import { InboxStore } from './store.js';
import { runTick, type Forge } from './tick.js';
import { buildView } from './view.js';
import { resolveDismiss, resolveOpen } from './open.js';
import { openPreparedSession, realOpenSessionDeps, type OpenSessionDeps } from './open-session.js';
import { inboxPage } from './page.js';

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
  /** The forge to poll; defaults to the real GitHub one. Overridden only by tests. */
  forge?: Forge;
  /** How a prepared review is brought up as a session; defaults to the real one. Tests override it. */
  openDeps?: OpenSessionDeps;
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
    forge: options.forge ?? realForge,
    prepare: (snapshot: Parameters<typeof preparePr>[0]) => preparePr(snapshot, config, prepareDeps),
    removeWorktree: (worktree: string, repo: string) => reclaimWorktree(config, worktree, repo),
    log,
    now: () => new Date().toISOString(),
    shouldContinue: () => !stopping,
    maxPrepared: config.maxPrepared,
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
    // No port to acquire and no other daemon to be, so no reclaim: a single pass must not kill the
    // servers of a daemon that is already running and may be mid-prepare.
    await tick();
    store.close();
    return { port: null, stop: () => Promise.resolve() };
  }

  // Bind the port first: it is the daemon's singleton lock, so a second daemon exits here (via the
  // server's error handler) before it can reclaim and kill the first one's in-flight servers.
  const openDeps = options.openDeps ?? realOpenSessionDeps(nodePath, entry);
  const server = await bindInboxServer(store, config, log, openDeps);
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

export function startInboxServer(store: InboxStore, config: InboxConfig, log: (message: string) => void, openDeps: OpenSessionDeps): Server {
  const server = createServer((req, res) => {
    // The whole handler is guarded: an unhandled throw here (a malformed percent-escape, say) would
    // otherwise have no catch and take the long-running daemon down with it.
    try {
      // Loopback binding is not enough on its own: a page on another site can rebind its own
      // hostname to 127.0.0.1, so a stranger's Host header must not reach the reviewer's PR list.
      // Judged against the connection's own port, which is the port actually bound.
      if (!isLocalHost(req.headers.host, req.socket.localPort)) {
        res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('forbidden');
        return;
      }

      // The host the reader actually used — localhost or 127.0.0.1, already checked — so the links
      // on the page point back at the same origin and a click on them is not cross-site.
      const openBase = `http://${req.headers.host}`;
      const url = req.url ?? '/';

      if (req.method === 'GET' && (url === '/' || url === '/index.html')) {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(inboxPage());
        return;
      }
      if (req.method === 'GET' && (url === '/api/inbox' || url === '/api/inbox/')) {
        const view = buildView(store, openBase, new Date().toISOString());
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(view));
        return;
      }
      if (req.method === 'GET' && url.startsWith('/open/')) {
        const id = stateChangingId(req, res, '/open/');
        if (id !== null) {
          void handleOpen(store, id, openDeps, log, res).catch(err => log(`open failed: ${err instanceof Error ? err.message : err}`));
        }
        return;
      }
      if (req.method === 'POST' && url.startsWith('/dismiss/')) {
        const id = stateChangingId(req, res, '/dismiss/');
        if (id !== null) {
          handleDismiss(store, config, id, log, res);
        }
        return;
      }
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'not found' }));
    } catch (err) {
      log(`request handler error: ${err instanceof Error ? err.message : err}`);
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
      }
      res.end('internal error');
    }
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

/** Brings a prepared review up as a live session and redirects the browser to it. */
async function handleOpen(store: InboxStore, id: string, openDeps: OpenSessionDeps, log: (message: string) => void, res: ServerResponse): Promise<void> {
  try {
    const resolution = resolveOpen(store, id);
    if (!resolution.ok) {
      res.writeHead(resolution.status, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end(resolution.message);
      return;
    }
    log(`opening ${id}`);
    const { url, imported, importError } = await openPreparedSession(resolution.pr.worktreePath!, resolution.pr.bundlePath!, resolution.pr.number, openDeps);
    if (!imported) {
      log(`opened ${id} but its findings did not import: ${importError}`);
    }
    res.writeHead(302, { Location: url });
    res.end();
  } catch (err) {
    log(`could not open ${id}: ${err instanceof Error ? err.message : err}`);
    if (!res.headersSent) {
      res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end(`Could not open ${id}: ${err instanceof Error ? err.message : err}`);
    }
  }
}

/**
 * The id a state-changing route was asked about, or null once the request has been answered: a
 * cross-site fetch — a drive-by trying to spawn a session or dismiss a review — is refused, and a
 * malformed escape is a bad request. A click from the inbox page is same-origin, a direct
 * navigation has no site.
 */
function stateChangingId(req: IncomingMessage, res: ServerResponse, prefix: string): string | null {
  if (req.headers['sec-fetch-site'] === 'cross-site') {
    res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('forbidden');
    return null;
  }
  try {
    return decodeURIComponent((req.url ?? '').slice(prefix.length));
  } catch {
    res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('bad request');
    return null;
  }
}

/** Marks a pull request as one the reviewer will not review, and reclaims its worktree. */
function handleDismiss(store: InboxStore, config: InboxConfig, id: string, log: (message: string) => void, res: ServerResponse): void {
  const resolution = resolveDismiss(store, id);
  if (!resolution.ok) {
    res.writeHead(resolution.status, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end(resolution.message);
    return;
  }
  const { pr } = resolution;
  if (pr.worktreePath) {
    reclaimWorktree(config, pr.worktreePath, pr.repo);
    store.setPaths(pr.id, { worktreePath: null });
  }
  store.setStatus(pr.id, 'dismissed', 'dismissed by the reviewer');
  log(`dismissed ${pr.id}`);
  res.writeHead(204);
  res.end();
}

/**
 * Removes a pull request's worktree, first stopping any diffity server the reviewer opened on it.
 * That session lives in the reviewer's own registry and would otherwise keep serving a directory
 * that no longer exists.
 */
export function reclaimWorktree(config: InboxConfig, worktree: string, repo: string): void {
  const instance = findInstanceForRepo(repoHash(worktree));
  if (instance) {
    killInstance(instance);
  }
  removeWorktree(cloneDir(config.reposDir, repo), worktree);
}

/** A request whose Host is this loopback server's own address (localhost or 127.0.0.1, right port). */
function isLocalHost(host: string | undefined, port: number | undefined): boolean {
  return port != null && (host === `localhost:${port}` || host === `127.0.0.1:${port}`);
}

/** Resolves once the port is held; a clash exits through the server's own error handler first. */
function bindInboxServer(store: InboxStore, config: InboxConfig, log: (message: string) => void, openDeps: OpenSessionDeps): Promise<Server> {
  const server = startInboxServer(store, config, log, openDeps);
  return new Promise(resolve => server.once('listening', () => resolve(server)));
}
