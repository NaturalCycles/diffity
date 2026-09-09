import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { LiveRequest } from '@diffity/api';
import { createReview, fetchPrContext, type PrSnapshot } from '@diffity/github';
import { createWriteStream, mkdirSync, readFileSync, rmSync, writeFileSync, type WriteStream } from 'node:fs';
import { dirname, join } from 'node:path';
import type { ExportOpts, MarkPostedOpts, PrepareDeps, RunAgentOpts, ServerHandle } from './prepare.js';
import type { InboxConfig } from './config.js';
import { buildAgentArgv, skillBody } from './agent-argv.js';
import { parseAgentOutput } from './agent-output.js';
import { parseAwaitOutcome, type AttendantDeps } from './attendant.js';
import { prId, runRecordOf, type RunRecord } from './store.js';
import { parseThreadList, type ReviewThread } from './validate.js';
import { diffityDir } from '../registry.js';

/**
 * What the prepares currently have running, so the daemon can stop them on shutdown. A server's
 * stop and an agent's kill join the set as they start and leave it as they end; a shutdown calls
 * whatever is still in it. A set, not one of each: a bumped pull request is prepared alongside
 * whatever the daemon is already preparing, so several servers and agents are running at once.
 */
export interface Inflight {
  stops: Set<() => void>;
}

/** An `Inflight` of its own, for a caller that is not sharing the daemon's. */
export function noneInflight(): Inflight {
  return { stops: new Set() };
}

/**
 * The real side effects behind `preparePr`. `entry` is this CLI's own bundle, so a prepared review
 * runs the exact diffity the daemon is part of; `nodePath` is the interpreter to run it with.
 * `dataDirFor` gives each pull request its own diffity data directory, so a prepared session never
 * mixes with the reviewer's own diffity or with the previous run's findings on a re-prepare.
 */
export function realPrepareDeps(nodePath: string, entry: string, dataDirFor: (worktree: string) => string, config: InboxConfig, log: (message: string) => void, inflight: Inflight = noneInflight()): PrepareDeps {
  return {
    startServer: async (worktree, diffRef) => {
      const handle = await startDiffityServer(nodePath, entry, worktree, diffRef, dataDirFor(worktree));
      const stop = () => { handle.stop(); inflight.stops.delete(stop); };
      inflight.stops.add(stop);
      return { port: handle.port, stop };
    },
    agentArgv: () => buildAgentArgv({ nodePath, entry, agent: config.agent, systemPrompt: skillBody(entry, 'diffity-review', log) }),
    // No review skill: this pass checks findings that are already written, and is told how in its
    // prompt rather than sent to review the diff again.
    validateArgv: () => buildAgentArgv({
      nodePath, entry,
      agent: { ...config.agent, model: config.validate.model, maxBudgetUsd: config.validate.maxBudgetUsd },
      systemPrompt: null,
    }),
    runAgent: opts => runAgent(opts, dataDirFor(opts.cwd), config.agent.mcpAllow, inflight),
    listThreads: worktree => listThreads(nodePath, entry, worktree, dataDirFor(worktree)),
    prContext: (snapshot, worktree) => writePrContext(snapshot, dataDirFor(worktree), log),
    // In this process, with the reviewer's own credentials: posting the alert findings is the
    // daemon's own act, after the agent has finished, and never something the agent can reach.
    postReview: opts => createReview(opts.owner, opts.repo, opts.prNumber, opts.headSha, opts.submission),
    markPosted: opts => markPosted(nodePath, entry, opts, dataDirFor(opts.worktree)),
    exportBundle: opts => exportBundle(nodePath, entry, opts, dataDirFor(opts.worktree)),
    log,
    now: () => new Date().toISOString(),
  };
}

/** What the reviewer's discussion file is called, in the pull request's own data directory. */
const PR_CONTEXT_FILE = 'pr-context.json';

/**
 * The pull request's description and discussion as JSON beside the prepared session, read with the
 * daemon's own credentials because the agent runs without any. Never written into the worktree,
 * where an untracked file would turn up in the review's own diff. Null when the forge could not be
 * read: the review goes ahead without the discussion, and the reason is logged.
 */
async function writePrContext(snapshot: PrSnapshot, dataDir: string, log: (message: string) => void): Promise<string | null> {
  const path = join(dataDir, PR_CONTEXT_FILE);
  try {
    const context = await fetchPrContext(snapshot);
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(path, JSON.stringify(context, null, 2) + '\n');
    return path;
  } catch (err) {
    log(`could not read the discussion on ${prId(snapshot)}: ${err instanceof Error ? err.message : err}`);
    return null;
  }
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
export function runAgent(opts: RunAgentOpts, dataDir: string, mcpAllow: string[] = [], inflight: Inflight = noneInflight()): Promise<{ stdout: string; timedOut: boolean }> {
  mkdirSync(dirname(opts.logPath), { recursive: true });
  const log = createWriteStream(opts.logPath, { flags: opts.appendLog ? 'a' : 'w' });
  // The log is a convenience, not the contract: a path that cannot be opened or written must not
  // raise an unhandled 'error' on the stream and take the daemon down mid-review.
  log.on('error', () => { /* the run's own outcome is what the caller waits on */ });
  const [command, ...args] = opts.argv;

  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: opts.cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: true,
      env: agentEnv(dataDir, mcpAllow),
    });
    const kill = () => killGroup(child.pid, 'SIGTERM');
    inflight.stops.add(kill);
    let stdout = '';
    let settled = false;
    let escalate: ReturnType<typeof setTimeout> | undefined;
    const clearInflight = () => { inflight.stops.delete(kill); };

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
      if (!settled) { settled = true; clearTimeout(timer); if (escalate) clearTimeout(escalate); log.end(); reject(new Error(`could not run the agent command "${command}": ${err.message}`)); }
    });
    child.on('close', () => {
      clearInflight();
      clearTimeout(timer);
      if (escalate) clearTimeout(escalate);
      if (!settled) {
        settled = true;
        // The tee above holds the raw JSON of a `--output-format json` run; the text the agent
        // would otherwise have printed goes in after it, so the log stays readable.
        const { text, stats } = parseAgentOutput(stdout);
        if (stats) {
          log.write(`\n--- result ---\n${text}\n`);
        }
        // Resolved only once the log is on disk: the caller hands that path straight to the store,
        // and the reader may open it before the next line of the daemon runs.
        endLog(log, () => resolve({ stdout, timedOut: false }));
      }
    });
  });
}

/** Closes the log and calls back once it is written — or once it has failed, which is not fatal. */
function endLog(log: WriteStream, done: () => void): void {
  let called = false;
  const once = () => { if (!called) { called = true; done(); } };
  log.once('error', once);
  log.end(once);
}

/**
 * The agent's environment, with every way it could reach the forge on the reviewer's behalf taken
 * away. This is defence in depth, not a sandbox: the command still runs the repository's own code,
 * so the promise it backs is "the daemon does not hand the agent your credentials", not "the agent
 * cannot possibly reach GitHub".
 */
function agentEnv(dataDir: string, mcpAllow: string[]): NodeJS.ProcessEnv {
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
  // What `inbox mcp-gate`, run as the agent's PreToolUse hook, judges each MCP call against.
  env.DIFFITY_MCP_ALLOW = mcpAllow.join(',');
  mkdirSync(env.GH_CONFIG_DIR, { recursive: true });
  return env;
}

/**
 * The real side effects behind an attendant. The wait is this CLI's own `agent await` over the
 * worktree; the answer is the same built agent command as a preparation, with the forge's
 * credentials stripped, but in the reviewer's own diffity data directory — the opened session lives
 * there, and the reply has to land in it. Every answer is an agent run, so `recordRun` puts it in
 * the same log as the preparations.
 */
export function realAttendantDeps(
  nodePath: string,
  entry: string,
  config: InboxConfig,
  logPathFor: (worktree: string) => string,
  log: (message: string) => void,
  recordRun: (run: RunRecord) => void = () => {},
): AttendantDeps {
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
    answer: async (worktree, pr, prompt, signal) => {
      const inflight = noneInflight();
      const onAbort = () => inflight.stops.forEach(stop => stop());
      signal.addEventListener('abort', onAbort, { once: true });
      const startedAt = new Date().toISOString();
      // A question is about a finding, which is the checking model's job when one is set.
      const model = config.validate.model ?? config.agent.model;
      try {
        const { stdout, timedOut } = await runAgent({
          // The live skill, not the review one: the live prompt tells the agent to follow it, and
          // the agent runs with none of the reviewer's installed skills to find it in.
          argv: buildAgentArgv({ nodePath, entry, agent: { ...config.agent, model }, systemPrompt: skillBody(entry, 'diffity-live', log) }),
          prompt, cwd: worktree, logPath: logPathFor(worktree),
          timeoutMs: config.liveTimeoutMinutes * 60_000, appendLog: true,
        }, diffityDir(), config.agent.mcpAllow, inflight);
        if (timedOut) {
          log(`the answering agent in ${worktree} did not finish within ${config.liveTimeoutMinutes} minutes`);
        }
        const { stats } = parseAgentOutput(stdout);
        // Killing the agent through the signal — the daemon stopping, the reader leaving — closes
        // the child like a clean exit, so only the signal itself tells that apart from an answer.
        const stopped = signal.aborted;
        recordRun(runRecordOf({
          prId: pr.id, headSha: pr.headSha, phase: 'answer',
          outcome: stopped || stats?.isError ? 'failed' : timedOut ? 'timeout' : 'answered',
          note: stopped ? 'stopped before it answered' : null,
          startedAt, endedAt: new Date().toISOString(), stats, configModel: model,
        }));
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

/** Every thread of the prepared session, read out of the pull request's own diffity data directory. */
async function listThreads(nodePath: string, entry: string, worktree: string, dataDir: string): Promise<ReviewThread[]> {
  const { stdout } = await promisify(execFile)(
    nodePath,
    [entry, '--repo', worktree, 'agent', 'list', '--json'],
    // A review's findings, bodies and all, come back on stdout; the 1 MB default is not enough.
    { env: { ...process.env, DIFFITY_DATA_DIR: dataDir }, maxBuffer: 64 * 1024 * 1024 },
  );
  return parseThreadList(stdout);
}

/** The posted findings marked as sent in the pull request's own diffity data directory. */
async function markPosted(nodePath: string, entry: string, opts: MarkPostedOpts, dataDir: string): Promise<void> {
  const idOf = new Map(opts.commentIds.map(comment => [comment.threadId, comment.githubCommentId]));
  const args = opts.threadIds.map(threadId => {
    const commentId = idOf.get(threadId);
    return commentId === undefined ? threadId : `${threadId}=${commentId}`;
  });
  await promisify(execFile)(
    nodePath,
    [
      entry, '--repo', opts.worktree, 'agent', 'mark-posted', '--head-sha', opts.headSha,
      ...(opts.reviewUrl === null ? [] : ['--review-url', opts.reviewUrl]),
      ...args,
    ],
    { env: { ...process.env, DIFFITY_DATA_DIR: dataDir } },
  );
}

async function exportBundle(nodePath: string, entry: string, opts: ExportOpts, dataDir: string): Promise<void> {
  mkdirSync(dirname(opts.outPath), { recursive: true });
  await promisify(execFile)(
    nodePath,
    [entry, '--repo', opts.worktree, 'agent', 'export-bundle', '--pr', String(opts.prNumber), '--out', opts.outPath],
    { env: { ...process.env, DIFFITY_DATA_DIR: dataDir } },
  );
}
