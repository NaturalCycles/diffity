import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { LiveRequest } from '@diffity/api';
import { createWriteStream, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { ExportOpts, PrepareDeps, RunAgentOpts, ServerHandle } from './prepare.js';
import type { InboxConfig } from './config.js';
import { parseAwaitOutcome, type AttendantDeps } from './attendant.js';
import { diffityDir } from '../registry.js';

/**
 * What a prepare currently has running, so the daemon can stop it on shutdown. Set as a server or
 * an agent starts and cleared as it ends; a shutdown mid-prepare calls whichever is set.
 */
export interface Inflight {
  serverStop?: () => void;
  agentKill?: () => void;
}

/**
 * The real side effects behind `preparePr`. `entry` is this CLI's own bundle, so a prepared review
 * runs the exact diffity the daemon is part of; `nodePath` is the interpreter to run it with.
 * `dataDirFor` gives each pull request its own diffity data directory, so a prepared session never
 * mixes with the reviewer's own diffity or with the previous run's findings on a re-prepare.
 */
export function realPrepareDeps(nodePath: string, entry: string, dataDirFor: (worktree: string) => string, inflight: Inflight = {}): PrepareDeps {
  return {
    startServer: async (worktree, diffRef) => {
      const handle = await startDiffityServer(nodePath, entry, worktree, diffRef, dataDirFor(worktree));
      inflight.serverStop = () => { handle.stop(); inflight.serverStop = undefined; };
      return { port: handle.port, stop: () => { handle.stop(); inflight.serverStop = undefined; } };
    },
    runAgent: opts => runAgent(opts, dataDirFor(opts.cwd), inflight),
    exportBundle: opts => exportBundle(nodePath, entry, opts, dataDirFor(opts.worktree)),
    now: () => new Date().toISOString(),
  };
}

interface RegistryRow { pid: number; port: number }

/**
 * Starts a diffity server over the worktree in its own data directory, and resolves once that
 * server — identified by the child's own pid, never by a path that a symlink could disguise —
 * has registered its port. `stop` kills exactly the process it started.
 */
export function startDiffityServer(nodePath: string, entry: string, worktree: string, diffRef: string, dataDir: string, waitMs = 30_000): Promise<ServerHandle> {
  // Start from an empty data directory: a re-prepare of the same pull request would otherwise find
  // the previous run's session as a sibling and carry its findings into the new one.
  rmSync(dataDir, { recursive: true, force: true });
  mkdirSync(dataDir, { recursive: true });
  const child = spawn(nodePath, [entry, '--repo', worktree, '--no-open', '--quiet', diffRef], {
    detached: true,
    stdio: 'ignore',
    env: { ...process.env, DIFFITY_DATA_DIR: dataDir },
  });
  child.unref();
  const pid = child.pid;

  const deadline = Date.now() + waitMs;
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (fn: () => void) => { if (!settled) { settled = true; fn(); } };

    const poll = () => {
      if (settled) {
        return;
      }
      const row = registeredByPid(dataDir, pid);
      if (row) {
        finish(() => resolve({ port: row.port, stop: () => stopServer(pid) }));
        return;
      }
      if (Date.now() >= deadline) {
        try { if (pid) process.kill(pid, 'SIGTERM'); } catch { /* already gone */ }
        finish(() => reject(new Error(`diffity did not start for ${worktree} within ${waitMs / 1000}s`)));
        return;
      }
      setTimeout(poll, 500);
    };
    child.on('error', err => finish(() => reject(new Error(`could not start diffity: ${err.message}`))));
    setTimeout(poll, 500);
  });
}

function registeredByPid(dataDir: string, pid: number | undefined): RegistryRow | null {
  if (!pid) {
    return null;
  }
  try {
    const rows = JSON.parse(readFileSync(join(dataDir, 'registry.json'), 'utf-8')) as RegistryRow[];
    return rows.find(row => row.pid === pid) ?? null;
  } catch {
    return null;
  }
}

function stopServer(pid: number | undefined): void {
  if (!pid) {
    return;
  }
  try { process.kill(pid, 'SIGTERM'); } catch { /* already gone */ }
}

/**
 * Runs the review agent with the prompt on stdin, teeing its output to the log and returning it.
 * The agent reads an attacker-controlled checkout with permissions off, so it is handed an
 * environment with the forge's credentials removed — the "never posts to GitHub" promise then does
 * not rest on the prompt alone. On a timeout the whole process group is killed, not just the direct
 * child, so a tool the agent spawned cannot outlive it.
 */
export function runAgent(opts: RunAgentOpts, dataDir: string, inflight: Inflight = {}): Promise<{ stdout: string; timedOut: boolean }> {
  mkdirSync(dirname(opts.logPath), { recursive: true });
  const log = createWriteStream(opts.logPath, { flags: opts.appendLog ? 'a' : 'w' });
  const [command, ...args] = opts.argv;

  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: opts.cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: true,
      env: agentEnv(dataDir),
    });
    inflight.agentKill = () => killGroup(child.pid, 'SIGTERM');
    let stdout = '';
    let settled = false;
    let escalate: ReturnType<typeof setTimeout> | undefined;
    const clearInflight = () => { inflight.agentKill = undefined; };

    const timer = setTimeout(() => {
      killGroup(child.pid, 'SIGTERM');
      // A SIGTERM the agent ignores must not hang the daemon forever.
      escalate = setTimeout(() => killGroup(child.pid, 'SIGKILL'), 5000);
      escalate.unref?.();
      if (!settled) { settled = true; log.end(); resolve({ stdout, timedOut: true }); }
    }, opts.timeoutMs);

    child.stdout.setEncoding('utf-8');
    child.stdout.on('data', chunk => { stdout += chunk; log.write(chunk); });
    child.stderr.on('data', chunk => log.write(chunk));
    child.stdin.on('error', () => { /* the agent may close stdin before we finish writing */ });
    child.stdin.end(opts.prompt);

    child.on('error', err => {
      clearInflight();
      if (!settled) { settled = true; clearTimeout(timer); if (escalate) clearTimeout(escalate); log.end(); reject(new Error(`could not run the prepare command "${command}": ${err.message}`)); }
    });
    child.on('close', () => {
      clearInflight();
      clearTimeout(timer);
      if (escalate) clearTimeout(escalate);
      if (!settled) { settled = true; log.end(); resolve({ stdout, timedOut: false }); }
    });
  });
}

/**
 * The agent's environment, with every way it could reach the forge on the reviewer's behalf taken
 * away. This is defence in depth, not a sandbox: the command still runs the repository's own code,
 * so the promise it backs is "the daemon does not hand the agent your credentials", not "the agent
 * cannot possibly reach GitHub".
 */
function agentEnv(dataDir: string): NodeJS.ProcessEnv {
  const env = { ...process.env };
  // gh's auth tokens, over HTTPS.
  delete env.GH_TOKEN;
  delete env.GITHUB_TOKEN;
  delete env.GH_ENTERPRISE_TOKEN;
  delete env.GITHUB_ENTERPRISE_TOKEN;
  // The keys behind an SSH remote.
  delete env.SSH_AUTH_SOCK;
  env.GIT_SSH_COMMAND = 'false';
  // Askpass helpers can hand git a secret without a terminal.
  delete env.GIT_ASKPASS;
  delete env.SSH_ASKPASS;
  // An empty gh config directory has no stored auth; a null global config and no system config drop
  // insteadOf rewrites and credential helpers; no terminal prompt means a push cannot ask for one.
  env.GH_CONFIG_DIR = join(dataDir, 'empty-gh');
  env.GIT_CONFIG_GLOBAL = '/dev/null';
  env.GIT_CONFIG_NOSYSTEM = '1';
  env.GIT_TERMINAL_PROMPT = '0';
  env.DIFFITY_DATA_DIR = dataDir;
  mkdirSync(env.GH_CONFIG_DIR, { recursive: true });
  return env;
}

/**
 * The real side effects behind an attendant. The wait is this CLI's own `agent await` over the
 * worktree; the answer is the configured agent command with the forge's credentials stripped, as
 * for preparation, but in the reviewer's own diffity data directory — the opened session lives
 * there, and the reply has to land in it.
 */
export function realAttendantDeps(nodePath: string, entry: string, config: InboxConfig, logPathFor: (worktree: string) => string, log: (message: string) => void): AttendantDeps {
  return {
    awaitRequest: (worktree, signal) => new Promise(resolve => {
      const child = spawn(nodePath, [entry, '--repo', worktree, 'agent', 'await', '--timeout', '240'], { stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = '';
      let stderr = '';
      child.stdout.setEncoding('utf-8');
      child.stderr.setEncoding('utf-8');
      child.stdout.on('data', chunk => { stdout += chunk; });
      child.stderr.on('data', chunk => { stderr += chunk; });
      const onAbort = () => { try { child.kill('SIGTERM'); } catch { /* gone */ } };
      signal.addEventListener('abort', onAbort, { once: true });
      child.on('error', err => { signal.removeEventListener('abort', onAbort); resolve({ kind: 'failed', reason: err.message }); });
      child.on('close', code => { signal.removeEventListener('abort', onAbort); resolve(parseAwaitOutcome(code, stdout, stderr)); });
    }),
    answer: async (worktree, prompt, signal) => {
      const inflight: Inflight = {};
      const onAbort = () => inflight.agentKill?.();
      signal.addEventListener('abort', onAbort, { once: true });
      try {
        const { timedOut } = await runAgent({
          argv: config.prepare, prompt, cwd: worktree, logPath: logPathFor(worktree),
          timeoutMs: config.liveTimeoutMinutes * 60_000, appendLog: true,
        }, diffityDir(), inflight);
        if (timedOut) {
          log(`the answering agent in ${worktree} did not finish within ${config.liveTimeoutMinutes} minutes`);
        }
        return { timedOut };
      } finally {
        signal.removeEventListener('abort', onAbort);
      }
    },
    giveUp: async (worktree, request: LiveRequest, note) => {
      await promisify(execFile)(nodePath, [
        entry, '--repo', worktree, 'agent', 'reply', request.threadId, '--aside', '--answers', request.commentId, '--body', note,
      ]);
    },
    log,
  };
}

function killGroup(pid: number | undefined, signal: NodeJS.Signals): void {
  if (!pid) {
    return;
  }
  // Negative pid signals the whole detached process group, so tools the agent spawned die with it.
  try { process.kill(-pid, signal); } catch {
    try { process.kill(pid, signal); } catch { /* already gone */ }
  }
}

async function exportBundle(nodePath: string, entry: string, opts: ExportOpts, dataDir: string): Promise<void> {
  mkdirSync(dirname(opts.outPath), { recursive: true });
  await promisify(execFile)(
    nodePath,
    [entry, '--repo', opts.worktree, 'agent', 'export-bundle', '--pr', String(opts.prNumber), '--out', opts.outPath],
    { env: { ...process.env, DIFFITY_DATA_DIR: dataDir } },
  );
}
