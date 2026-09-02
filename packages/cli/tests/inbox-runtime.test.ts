import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runAgent, startDiffityServer } from '../src/inbox/runtime.js';

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

  it('scrubs the forge credentials from the agent\'s environment', async () => {
    process.env.GH_TOKEN = 'secret-token';
    try {
      const argv = ['node', '-e', 'process.stdout.write(JSON.stringify({gh:process.env.GH_TOKEN??null,cfg:process.env.GIT_CONFIG_GLOBAL,prompt:process.env.GIT_TERMINAL_PROMPT}))'];
      const result = await runAgent(opts(argv), root);
      const env = JSON.parse(result.stdout);
      expect(env.gh).toBeNull();
      expect(env.cfg).toBe('/dev/null');
      expect(env.prompt).toBe('0');
    } finally {
      delete process.env.GH_TOKEN;
    }
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
