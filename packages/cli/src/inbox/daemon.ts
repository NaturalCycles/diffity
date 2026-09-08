import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { MAX_SETTINGS_TEXT, parseSettingsPatch } from './settings.js';
import { existsSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { basename, join } from 'node:path';
import { getViewerLogin, searchReviewRequested, viewPr, type PrSnapshot } from '@diffity/github';
import { saveInboxSettings, type InboxConfig, type InboxSettings } from './config.js';
import { inboxDir } from './paths.js';
import { logsDir, preparePr, type PrepareDeps, type PrepareResult } from './prepare.js';
import { noneInflight, realAttendantDeps, realPrepareDeps, type Inflight } from './runtime.js';
import { Attendants, type AttendedPr } from './attendant.js';
import { removeWorktree, cloneDir } from './worktree.js';
import { localHhMm } from './runs.js';
import { findInstanceForRepo, killInstance } from '../registry.js';
import { repoHash } from './open-session.js';
import { InboxStore } from './store.js';
import { prepareBumped, runTick, type Forge } from './tick.js';
import { buildView } from './view.js';
import { resolveBump, resolveDismiss, resolveOpen } from './open.js';
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
  /** Who parks on an opened review; defaults to the real attendants. Tests override it. */
  attendants?: AttendantHost;
  /** How one pull request is prepared; defaults to the real preparation. Tests override it. */
  prepare?: (snapshot: PrSnapshot, opts: { bumped: boolean; alreadyPostedHead: string | null }) => Promise<PrepareResult>;
  /** Where the prepares register what they have running, for the shutdown to stop; its own by default. */
  inflight?: Inflight;
  /** Where the page's settings are written; without it they change the running daemon only. */
  configPath?: string;
}

/** What the page may ask of the daemon beyond the store: park agents, tick, settings, and how the tick is doing. */
export interface ServerHooks {
  attendants?: AttendantHost | null;
  /** A bump wants this pull request prepared now, whatever else is being prepared. */
  onBump?: ((id: string) => void) | null;
  /** The page's ⟳: the same tick, asked for by hand. */
  onTick?: (() => void) | null;
  settings?: SettingsHost | null;
  status?: () => DaemonStatus;
}

export interface DaemonStatus {
  ticking: boolean;
  lastPollAt: string | null;
  /** Until when preparation is held back by the reviewer's Claude limit, or null when it is not. */
  pausedUntil: string | null;
}

/** The settings as the page reads and writes them: the running config, persisted when a path is known. */
export interface SettingsHost {
  get(): InboxSettings;
  update(settings: InboxSettings): void;
}

export function settingsHost(config: InboxConfig, configPath: string | undefined, onPollChanged: () => void = () => {}): SettingsHost {
  return {
    get: () => ({
      filter: config.filter, skipTitles: config.skipTitles, alertWhen: config.alertWhen, alertPaths: config.alertPaths,
      postAlerts: config.postAlerts, postPrefix: config.postPrefix,
      maxPrepared: config.maxPrepared, pollMinutes: config.pollMinutes,
      live: config.live, liveTimeoutMinutes: config.liveTimeoutMinutes, prepareTimeoutMinutes: config.prepareTimeoutMinutes,
      waitForCi: config.waitForCi, agent: config.agent, validate: config.validate,
    }),
    update: settings => {
      // The config object is the one the tick, the prepares and the opens read from, so the change
      // takes effect from the next of each; only the poll timer has to be told.
      const pollChanged = settings.pollMinutes !== config.pollMinutes;
      Object.assign(config, settings);
      if (configPath) {
        saveInboxSettings(configPath, settings);
      }
      if (pollChanged) {
        onPollChanged();
      }
    },
  };
}

/** What the open route asks of the attendants: park on this worktree, unless already there. */
export interface AttendantHost {
  ensure(worktree: string, pr: AttendedPr): void;
  stopAll(): void;
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
  let lastPollAt: string | null = null;

  const inflight = options.inflight ?? noneInflight();
  const prepareDeps: PrepareDeps = realPrepareDeps(nodePath, entry, inboxDataDir, config, log, inflight);
  // The pause outlives this process: a session limit is the reviewer's, not the daemon's, so it is
  // kept in the store and a restart does not spend a run rediscovering it.
  const pausedUntil = () => store.pausedUntil(new Date().toISOString());
  const deps = {
    forge: options.forge ?? realForge,
    prepare: options.prepare ?? ((snapshot: PrSnapshot, opts: { bumped: boolean; alreadyPostedHead: string | null }) => preparePr(snapshot, config, prepareDeps, opts)),
    removeWorktree: (worktree: string, repo: string) => reclaimWorktree(config, worktree, repo),
    log,
    now: () => new Date().toISOString(),
    shouldContinue: () => !stopping,
    // One set for the tick and the bumps: each knows what the other is already preparing.
    inFlight: new Set<string>(),
    // Read at each tick, not copied: the page can change it while the daemon runs.
    get maxPrepared() { return config.maxPrepared; },
    get waitForCi() { return config.waitForCi; },
    get skipTitles() { return config.skipTitles; },
    get alertPaths() { return config.alertPaths; },
    get agentModel() { return config.agent.model; },
    get validateModel() { return config.validate.model; },
    pauseUntil: (until: string) => {
      store.pauseUntil(until);
      log(`preparing paused until ${localHhMm(until)} — Claude session limit`);
    },
    pausedUntil,
  };

  // A ⟳ arriving mid-tick is served by another tick right after it, not by the next poll.
  let tickWanted = false;
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
      lastPollAt = new Date().toISOString();
      if (tickWanted && !stopping) {
        tickWanted = false;
        void tick();
      }
    }
  };
  const requestTick = () => {
    tickWanted = ticking;
    void tick();
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
  const attendants: AttendantHost = options.attendants ?? new Attendants(
    realAttendantDeps(nodePath, entry, config, worktree => join(logsDir(), `${basename(worktree)}.live.log`), log, run => store.recordRun(run)),
  );
  let timer: NodeJS.Timeout | undefined;
  const armPoll = () => {
    if (timer) {
      clearInterval(timer);
    }
    timer = setInterval(() => void tick(), config.pollMinutes * 60_000);
  };
  const settings = settingsHost(config, options.configPath, armPoll);
  const server = await bindInboxServer(store, config, log, openDeps, {
    attendants, onTick: requestTick, settings, status: () => ({ ticking, lastPollAt, pausedUntil: pausedUntil() }),
    // Not a tick: the ↑ prepares that one at once, beside whatever a tick is already preparing, and
    // the page's next refresh finds it `preparing`.
    onBump: id => void prepareBumped(store, deps, id)
      .catch(err => log(`could not prepare ${id}: ${err instanceof Error ? err.message : err}`)),
  });
  reclaimLeftoverServers(log);
  armPoll();
  void tick();

  return {
    port: config.port,
    stop: () => new Promise<void>(resolve => {
      stopping = true;
      if (timer) {
        clearInterval(timer);
      }
      // Kill whatever the prepares have running right now — every detached diffity server and every
      // agent with its group — so nothing outlives the daemon.
      for (const stop of [...inflight.stops]) {
        stop();
      }
      attendants.stopAll();
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

export function startInboxServer(store: InboxStore, config: InboxConfig, log: (message: string) => void, openDeps: OpenSessionDeps, hooks: ServerHooks = {}): Server {
  const attendants = hooks.attendants ?? null;
  const onBump = hooks.onBump ?? null;
  const settings = hooks.settings ?? null;
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
      if (settings && req.method === 'GET' && url === '/api/settings') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(settings.get()));
        return;
      }
      if (settings && req.method === 'POST' && url === '/api/settings') {
        if (req.headers['sec-fetch-site'] === 'cross-site') {
          res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
          res.end('forbidden');
          return;
        }
        void readBody(req, MAX_SETTINGS_TEXT * 4).then(body => {
          const patch = parseSettingsPatch(body);
          if (!patch.ok) {
            res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
            res.end(patch.message);
            return;
          }
          settings.update(patch.settings);
          log('settings saved from the page');
          res.writeHead(204);
          res.end();
        }).catch(err => {
          log(`settings could not be saved: ${err instanceof Error ? err.message : err}`);
          if (!res.headersSent) {
            res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
          }
          res.end('could not save');
        });
        return;
      }
      if (req.method === 'POST' && url === '/api/tick') {
        if (req.headers['sec-fetch-site'] === 'cross-site') {
          res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
          res.end('forbidden');
          return;
        }
        hooks.onTick?.();
        res.writeHead(204);
        res.end();
        return;
      }
      if (req.method === 'GET' && (url === '/api/inbox' || url === '/api/inbox/')) {
        const view = { ...buildView(store, openBase, new Date().toISOString()), ...(hooks.status?.() ?? { ticking: false, lastPollAt: null }) };
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(view));
        return;
      }
      if (req.method === 'GET' && url.startsWith('/open/')) {
        const id = stateChangingId(req, res, '/open/');
        if (id !== null) {
          void handleOpen(store, config, id, openDeps, attendants, log, res).catch(err => log(`open failed: ${err instanceof Error ? err.message : err}`));
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
      if (req.method === 'POST' && url.startsWith('/prepare/')) {
        const id = stateChangingId(req, res, '/prepare/');
        if (id !== null) {
          handleBump(store, id, onBump, log, res);
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

/** Brings a prepared review up as a live session, parks an agent on it, and redirects the browser to it. */
async function handleOpen(store: InboxStore, config: InboxConfig, id: string, openDeps: OpenSessionDeps, attendants: AttendantHost | null, log: (message: string) => void, res: ServerResponse): Promise<void> {
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
    const { pr } = resolution;
    if (config.live) {
      attendants?.ensure(pr.worktreePath!, { id: pr.id, url: pr.url, title: pr.title, author: pr.author, headSha: pr.preparedHeadSha ?? pr.headSha });
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

/** Puts a pull request at the front of the queue and has it prepared at once. */
function handleBump(store: InboxStore, id: string, onBump: ((id: string) => void) | null, log: (message: string) => void, res: ServerResponse): void {
  const resolution = resolveBump(store, id);
  if (!resolution.ok) {
    res.writeHead(resolution.status, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end(resolution.message);
    return;
  }
  store.bump(resolution.pr.id, new Date().toISOString());
  log(`${id} bumped — preparing it now`);
  res.writeHead(204);
  res.end();
  onBump?.(resolution.pr.id);
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
  store.setStatus(pr.id, 'dismissed', 'dismissed by the reviewer');
  store.setPaths(pr.id, { worktreePath: null });
  log(`dismissed ${pr.id}`);
  // The row is gone as far as the page is concerned; the directory can go at its own pace.
  res.writeHead(204);
  res.end();
  if (pr.worktreePath) {
    void reclaimWorktree(config, pr.worktreePath, pr.repo)
      .catch(err => log(`could not remove ${pr.worktreePath}: ${err instanceof Error ? err.message : err}`));
  }
}

/**
 * Removes a pull request's worktree, first stopping any diffity server the reviewer opened on it.
 * That session lives in the reviewer's own registry and would otherwise keep serving a directory
 * that no longer exists.
 */
export async function reclaimWorktree(config: InboxConfig, worktree: string, repo: string): Promise<void> {
  const instance = findInstanceForRepo(repoHash(worktree));
  if (instance) {
    killInstance(instance);
  }
  await removeWorktree(cloneDir(config.reposDir, repo), worktree);
}

/** The request body as text, refusing one past the limit rather than buffering it. */
function readBody(req: IncomingMessage, limit: number): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = '';
    req.setEncoding('utf-8');
    req.on('data', (chunk: string) => {
      body += chunk;
      if (body.length > limit) {
        reject(new Error('body too large'));
        req.destroy();
      }
    });
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

/** A request whose Host is this loopback server's own address (localhost or 127.0.0.1, right port). */
function isLocalHost(host: string | undefined, port: number | undefined): boolean {
  return port != null && (host === `localhost:${port}` || host === `127.0.0.1:${port}`);
}

/** Resolves once the port is held; a clash exits through the server's own error handler first. */
function bindInboxServer(store: InboxStore, config: InboxConfig, log: (message: string) => void, openDeps: OpenSessionDeps, hooks: ServerHooks): Promise<Server> {
  const server = startInboxServer(store, config, log, openDeps, hooks);
  return new Promise(resolve => server.once('listening', () => resolve(server)));
}
