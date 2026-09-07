import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { realAttendantDeps, runAgent, startDiffityServer } from '../src/inbox/runtime.js';

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'diffity-runtime-'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

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

    const config = {
      pollMinutes: 5, port: 0, reposDir: root, worktreesDir: root, filter: '', alertWhen: '',
      agent: { model: null, effort: null, mcpAllow: [], extraArgs: [], maxBudgetUsd: null },
      prepareTimeoutMinutes: 30, maxPrepared: 5, live: true, liveTimeoutMinutes: 10,
    };
    const deps = realAttendantDeps(process.execPath, entry, config, () => join(root, 'live.log'), () => {});

    const path = process.env.PATH;
    const dataDir = process.env.DIFFITY_DATA_DIR;
    process.env.PATH = `${bin}:${path ?? ''}`;
    // An answer runs in the reviewer's own data directory, which here must not be their real one.
    process.env.DIFFITY_DATA_DIR = join(root, 'data');
    try {
      await deps.answer(root, 'the live prompt\n', new AbortController().signal);
    } finally {
      process.env.PATH = path;
      if (dataDir === undefined) {
        delete process.env.DIFFITY_DATA_DIR;
      } else {
        process.env.DIFFITY_DATA_DIR = dataDir;
      }
    }

    const argv = JSON.parse(readFileSync(argvPath, 'utf-8')) as string[];
    const at = argv.indexOf('--append-system-prompt');
    expect(at).toBeGreaterThan(-1);
    expect(argv[at + 1]).toBe('# Diffity Live Skill\n\nAnswer it.\n');
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
