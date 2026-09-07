import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

const ENTRY = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist', 'index.js');
import { realAttendantDeps, realPrepareDeps, runAgent, startDiffityServer } from '../src/inbox/runtime.js';
import { generalCommentIdOf, threadsToValidate } from '../src/inbox/validate.js';
import type { AttendedPr } from '../src/inbox/attendant.js';
import type { InboxConfig } from '../src/inbox/config.js';
import type { RunRecord } from '../src/inbox/store.js';

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'diffity-runtime-'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function attendedPr(): AttendedPr {
  return { id: 'o/r#4', url: 'https://github.com/o/r/pull/4', title: 'A change', author: 'alice', headSha: 'aaa' };
}

function liveConfig(): InboxConfig {
  return {
    pollMinutes: 5, port: 0, reposDir: root, worktreesDir: root, filter: '', alertWhen: '', alertPaths: [],
    agent: { model: 'the-configured-model', effort: null, mcpAllow: [], extraArgs: [], maxBudgetUsd: null },
    validate: { model: null, timeoutMinutes: 15, maxBudgetUsd: null },
    waitForCi: false, prepareTimeoutMinutes: 30, maxPrepared: 5, live: true, liveTimeoutMinutes: 10,
  };
}

/** A `claude` on PATH for the length of the call, with the reviewer's data directory redirected. */
async function withStandInAgent(bin: string, run: () => Promise<void>): Promise<void> {
  const path = process.env.PATH;
  const dataDir = process.env.DIFFITY_DATA_DIR;
  process.env.PATH = `${bin}:${path ?? ''}`;
  // An answer runs in the reviewer's own data directory, which here must not be their real one.
  process.env.DIFFITY_DATA_DIR = join(root, 'data');
  try {
    await run();
  } finally {
    process.env.PATH = path;
    if (dataDir === undefined) {
      delete process.env.DIFFITY_DATA_DIR;
    } else {
      process.env.DIFFITY_DATA_DIR = dataDir;
    }
  }
}

function opts(argv: string[], over: Partial<Parameters<typeof runAgent>[0]> = {}) {
  return {
    argv,
    prompt: 'the prompt\n',
    cwd: root,
    logPath: join(root, 'agent.log'),
    timeoutMs: 5000,
    ...over,
  };
}

describe('runAgent', () => {
  it('feeds the prompt on stdin, returns stdout, and tees everything to the log', async () => {
    // Echoes the prompt to stdout and a line to stderr; both must reach the log, stdout the caller.
    const argv = ['node', '-e', 'process.stdin.on("data",d=>process.stdout.write(d));process.stderr.write("noise\\n")'];
    const result = await runAgent(opts(argv), root);

    expect(result.timedOut).toBe(false);
    expect(result.stdout).toContain('the prompt');
    const log = readFileSync(join(root, 'agent.log'), 'utf-8');
    expect(log).toContain('the prompt');
    expect(log).toContain('noise');
  });

  it('scrubs every way to the forge from the agent\'s environment', async () => {
    process.env.GH_TOKEN = 'secret-token';
    process.env.SSH_AUTH_SOCK = '/tmp/agent.sock';
    try {
      const argv = ['node', '-e', 'process.stdout.write(JSON.stringify({gh:process.env.GH_TOKEN??null,ssh:process.env.SSH_AUTH_SOCK??null,sshCmd:process.env.GIT_SSH_COMMAND,cfg:process.env.GIT_CONFIG_GLOBAL,nosystem:process.env.GIT_CONFIG_NOSYSTEM,prompt:process.env.GIT_TERMINAL_PROMPT}))'];
      const result = await runAgent(opts(argv), root);
      const env = JSON.parse(result.stdout);
      expect(env.gh).toBeNull();
      expect(env.ssh).toBeNull();
      expect(env.sshCmd).toBe('false');
      expect(env.cfg).toBe('/dev/null');
      expect(env.nosystem).toBe('1');
      expect(env.prompt).toBe('0');
    } finally {
      delete process.env.GH_TOKEN;
      delete process.env.SSH_AUTH_SOCK;
    }
  });

  it('hands the allowlist to the agent, so its gate hook can read it', async () => {
    const argv = ['node', '-e', 'process.stdout.write(process.env.DIFFITY_MCP_ALLOW ?? "unset")'];
    expect((await runAgent(opts(argv), root, ['mcp__a__b', 'mcp__c__d'])).stdout).toBe('mcp__a__b,mcp__c__d');
    expect((await runAgent(opts(argv), root)).stdout).toBe('');
  });

  it('appends the text of a JSON result to the log, so the raw output stays readable', async () => {
    const result = JSON.stringify({ type: 'result', subtype: 'success', result: 'reviewing\nPREPARED' });
    const argv = ['node', '-e', `process.stdout.write(${JSON.stringify(result)})`];
    const run = await runAgent(opts(argv), root);

    expect(run.stdout).toBe(result);
    const log = readFileSync(join(root, 'agent.log'), 'utf-8');
    expect(log).toBe(`${result}\n--- result ---\nreviewing\nPREPARED\n`);
  });

  it('leaves the log as it came when the output is not a JSON result', async () => {
    const argv = ['node', '-e', 'process.stdout.write("reviewing\\nPREPARED\\n")'];
    await runAgent(opts(argv), root);
    expect(readFileSync(join(root, 'agent.log'), 'utf-8')).toBe('reviewing\nPREPARED\n');
  });

  it('reports a timeout and kills a hung agent rather than hanging', async () => {
    const argv = ['node', '-e', 'setInterval(()=>{},1000)'];
    const result = await runAgent(opts(argv, { timeoutMs: 300 }), root);
    expect(result.timedOut).toBe(true);
  });

  it('rejects when the command does not exist', async () => {
    await expect(runAgent(opts(['definitely-not-a-real-command-xyz']), root)).rejects.toThrow(/could not run/);
  });
});

describe('realAttendantDeps', () => {
  it('ships the live skill in the answering agent\'s system prompt', async () => {
    // The agent runs with none of the reviewer's installed skills, so the skill the live prompt
    // tells it to follow has to travel with the command. Read off a stand-in `claude` on PATH,
    // which records the argv it was given.
    mkdirSync(join(root, 'skills', 'diffity-live'), { recursive: true });
    writeFileSync(join(root, 'skills', 'diffity-live', 'SKILL.md'), '---\nname: diffity-live\n---\n\n# Diffity Live Skill\n\nAnswer it.\n');
    const entry = join(root, 'index.js');

    const argvPath = join(root, 'argv.json');
    const dump = join(root, 'dump.cjs');
    writeFileSync(dump, `require('fs').writeFileSync(${JSON.stringify(argvPath)}, JSON.stringify(process.argv.slice(2)));\n`);
    const bin = join(root, 'bin');
    mkdirSync(bin, { recursive: true });
    writeFileSync(join(bin, 'claude'), `#!/bin/sh\nexec '${process.execPath}' '${dump}' "$@"\n`, { mode: 0o755 });

    const deps = realAttendantDeps(process.execPath, entry, liveConfig(), () => join(root, 'live.log'), () => {});

    await withStandInAgent(bin, () => deps.answer(root, attendedPr(), 'the live prompt\n', new AbortController().signal).then(() => {}));

    const argv = JSON.parse(readFileSync(argvPath, 'utf-8')) as string[];
    const at = argv.indexOf('--append-system-prompt');
    expect(at).toBeGreaterThan(-1);
    expect(argv[at + 1]).toBe('# Diffity Live Skill\n\nAnswer it.\n');
  });

  it('answers with the checking model when one is set, and logs it as the model asked for', async () => {
    // A question is about a finding, so the pass that checks findings is the one that answers.
    mkdirSync(join(root, 'skills', 'diffity-live'), { recursive: true });
    writeFileSync(join(root, 'skills', 'diffity-live', 'SKILL.md'), '---\nname: diffity-live\n---\n\nAnswer it.\n');
    const argvPath = join(root, 'argv.json');
    const dump = join(root, 'dump.cjs');
    writeFileSync(dump, `require('fs').writeFileSync(${JSON.stringify(argvPath)}, JSON.stringify(process.argv.slice(2)));\n`);
    const bin = join(root, 'bin');
    mkdirSync(bin, { recursive: true });
    writeFileSync(join(bin, 'claude'), `#!/bin/sh\nexec '${process.execPath}' '${dump}' "$@"\n`, { mode: 0o755 });

    const config = { ...liveConfig(), validate: { model: 'the-checking-model', timeoutMinutes: 15, maxBudgetUsd: 9 } };
    const runs: RunRecord[] = [];
    const deps = realAttendantDeps(process.execPath, join(root, 'index.js'), config, () => join(root, 'live.log'), () => {}, run => runs.push(run));

    await withStandInAgent(bin, () => deps.answer(root, attendedPr(), 'the live prompt\n', new AbortController().signal).then(() => {}));

    const argv = JSON.parse(readFileSync(argvPath, 'utf-8')) as string[];
    expect(argv[argv.indexOf('--model') + 1]).toBe('the-checking-model');
    // The answer keeps the drafting budget: validate.maxBudgetUsd is for the checking pass only.
    expect(argv).not.toContain('--max-budget-usd');
    expect(runs[0]).toMatchObject({ phase: 'answer', model: 'the-checking-model' });
  });

  it('logs the answer as a run against the pull request it was asked about', async () => {
    mkdirSync(join(root, 'skills', 'diffity-live'), { recursive: true });
    writeFileSync(join(root, 'skills', 'diffity-live', 'SKILL.md'), '---\nname: diffity-live\n---\n\nAnswer it.\n');
    const result = JSON.stringify({
      type: 'result', subtype: 'success', is_error: false, result: 'answered', total_cost_usd: 0.4,
      duration_ms: 90_000, num_turns: 3, usage: { output_tokens: 500 }, modelUsage: { 'claude-x': {} },
    });
    const bin = join(root, 'bin');
    mkdirSync(bin, { recursive: true });
    writeFileSync(join(bin, 'claude'), `#!/bin/sh\ncat > /dev/null\ncat <<'JSON'\n${result}\nJSON\n`, { mode: 0o755 });

    const runs: RunRecord[] = [];
    const deps = realAttendantDeps(process.execPath, join(root, 'index.js'), liveConfig(), () => join(root, 'live.log'), () => {}, run => runs.push(run));

    await withStandInAgent(bin, () => deps.answer(root, attendedPr(), 'the live prompt\n', new AbortController().signal).then(() => {}));

    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({
      prId: 'o/r#4', headSha: 'aaa', phase: 'answer', outcome: 'answered', model: 'claude-x',
      turns: 3, costUsd: 0.4, durationMs: 90_000, outputTokens: 500,
    });
  });

  it('logs an answer the daemon stopped as a failure rather than an answer', async () => {
    mkdirSync(join(root, 'skills', 'diffity-live'), { recursive: true });
    writeFileSync(join(root, 'skills', 'diffity-live', 'SKILL.md'), '---\nname: diffity-live\n---\n\nAnswer it.\n');
    const bin = join(root, 'bin');
    mkdirSync(bin, { recursive: true });
    // Takes the prompt and then hangs, so the abort is what ends it — and a killed child closes
    // as cleanly as one that answered.
    writeFileSync(join(bin, 'claude'), '#!/bin/sh\ncat > /dev/null\nsleep 30\n', { mode: 0o755 });

    const runs: RunRecord[] = [];
    const deps = realAttendantDeps(process.execPath, join(root, 'index.js'), liveConfig(), () => join(root, 'live.log'), () => {}, run => runs.push(run));
    const control = new AbortController();

    await withStandInAgent(bin, async () => {
      const answering = deps.answer(root, attendedPr(), 'the live prompt\n', control.signal);
      setTimeout(() => control.abort(), 300);
      await answering;
    });

    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ prId: 'o/r#4', phase: 'answer', outcome: 'failed', note: 'stopped before it answered' });
  });
});

describe('startDiffityServer', () => {
  it('resolves with the port the spawned server registered for its own pid', async () => {
    // A stand-in for the diffity entry: it writes a registry row for its own pid, then idles.
    const port = 43219;
    const fakeEntry = join(root, 'fake-diffity.mjs');
    writeFileSyncEntry(fakeEntry, port);

    const handle = await startDiffityServer(process.execPath, fakeEntry, join(root, 'wt'), 'main', join(root, 'data'), 5000);
    expect(handle.port).toBe(port);
    handle.stop();
  });

  it('times out and does not resolve when nothing registers', async () => {
    const fakeEntry = join(root, 'silent.mjs');
    writeFileSyncSilent(fakeEntry);
    await expect(
      startDiffityServer(process.execPath, fakeEntry, join(root, 'wt2'), 'main', join(root, 'data2'), 800),
    ).rejects.toThrow(/did not start/);
  });
});

describe('the real listThreads', () => {
  it('reads the findings a diffity session over the worktree holds', async () => {
    const repo = join(root, 'repo');
    const dataDir = join(root, 'pr-data');
    execFileSync('git', ['init', '-b', 'main', repo], { stdio: 'pipe' });
    execFileSync('git', ['config', 'user.email', 't@t'], { cwd: repo, stdio: 'pipe' });
    execFileSync('git', ['config', 'user.name', 'T'], { cwd: repo, stdio: 'pipe' });
    writeFileSync(join(repo, 'a.ts'), 'const a = 1;\n');
    execFileSync('git', ['add', '.'], { cwd: repo, stdio: 'pipe' });
    execFileSync('git', ['commit', '-m', 'init'], { cwd: repo, stdio: 'pipe' });
    execFileSync('git', ['checkout', '-q', '-b', 'work'], { cwd: repo, stdio: 'pipe' });
    writeFileSync(join(repo, 'a.ts'), 'const a = 1;\nconst token = leak();\n');
    execFileSync('git', ['commit', '-qam', 'change'], { cwd: repo, stdio: 'pipe' });

    const server = await startDiffityServer(process.execPath, ENTRY, repo, 'main', dataDir, 20_000);
    try {
      const agent = (args: string[]) => execFileSync(process.execPath, [ENTRY, '--repo', repo, 'agent', ...args], {
        stdio: 'pipe', env: { ...process.env, DIFFITY_DATA_DIR: dataDir },
      });
      agent(['comment', '--file', 'a.ts', '--line', '2', '--body', 'P1: this leaks the token']);
      agent(['general-comment', '--body', 'Looks risky, 1 P1']);

      const deps = realPrepareDeps(process.execPath, ENTRY, () => dataDir, liveConfig(), () => {});
      const threads = await deps.listThreads(repo);

      const finding = threads.find(thread => thread.filePath === 'a.ts');
      expect(finding).toBeDefined();
      expect(finding).toMatchObject({ startLine: 2, endLine: 2, side: 'new', status: 'open' });
      expect(finding!.threadId).toMatch(/\w/);
      expect(finding!.comments[0]).toMatchObject({ body: 'P1: this leaks the token' });
      expect(finding!.comments[0].id).toMatch(/\w/);
      expect(threadsToValidate(threads).map(thread => thread.threadId)).toEqual([finding!.threadId]);
      expect(generalCommentIdOf(threads)).toMatch(/\w/);
    } finally {
      server.stop();
    }
  }, 40_000);
});

// Helpers kept below the tests they serve.
import { writeFileSync } from 'node:fs';

function writeFileSyncEntry(path: string, port: number): void {
  writeFileSync(path, `
    import { writeFileSync, mkdirSync } from 'node:fs';
    import { join } from 'node:path';
    const dir = process.env.DIFFITY_DATA_DIR;
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'registry.json'), JSON.stringify([{ pid: process.pid, port: ${port} }]));
    setInterval(() => {}, 1000);
  `);
}

function writeFileSyncSilent(path: string): void {
  writeFileSync(path, 'setInterval(() => {}, 1000);\n');
}
