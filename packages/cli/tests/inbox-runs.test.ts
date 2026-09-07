import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { InboxStore, type RunRecord } from '../src/inbox/store.js';

const DIST_ENTRY = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist', 'index.js');

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'diffity-runs-'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function record(over: Partial<RunRecord> = {}): RunRecord {
  const startedAt = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  return {
    prId: 'o/r#1', headSha: 'aaa', phase: 'prepare', model: 'claude-x',
    startedAt, endedAt: startedAt, durationMs: 480_000, turns: 12, costUsd: 1.2,
    inputTokens: 30, outputTokens: 27_000, cacheReadTokens: 1_100_000, cacheWriteTokens: 76_000,
    outcome: 'prepared', note: null, ...over,
  };
}

/** Runs seeded into the store the command reads, under its own data directory. */
function seed(...rows: RunRecord[]): void {
  const store = new InboxStore(join(root, 'inbox', 'inbox.sqlite'));
  for (const row of rows) {
    store.recordRun(row);
  }
  store.close();
}

function runs(args: string[]): Promise<{ code: number | null; stdout: string }> {
  return new Promise(resolve => {
    const child = spawn(process.execPath, [DIST_ENTRY, 'inbox', 'runs', ...args], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, DIFFITY_DATA_DIR: root },
    });
    let stdout = '';
    child.stdout.setEncoding('utf-8');
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.resume();
    child.on('close', code => resolve({ code, stdout }));
  });
}

describe('diffity inbox runs', () => {
  it('lists the runs with what they spent, and adds them up', async () => {
    seed(
      record(),
      record({ phase: 'answer', outcome: 'answered', model: 'claude-y', turns: 3, costUsd: 0.4, durationMs: 60_000, outputTokens: 500, cacheReadTokens: 40_000 }),
    );

    const { code, stdout } = await runs([]);

    expect(code).toBe(0);
    expect(stdout).toContain('when');
    expect(stdout).toContain('o/r#1');
    expect(stdout).toMatch(/prepare .*claude-x .*12 .*8\.0 .*\$1\.20 .*out 27k · read 1\.1M .*prepared/);
    expect(stdout).toMatch(/answer .*claude-y .*3 .*1\.0 .*\$0\.40 .*out 500 · read 40k .*answered/);
    expect(stdout).toContain('2 runs · 9 min · $1.60 over the last 7 day(s)');
  });

  it('leaves out what is older than the window, and says when there is nothing', async () => {
    const old = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    seed(record({ startedAt: old, endedAt: old }));

    expect((await runs(['--since', '2'])).stdout).toContain('No agent runs in the last 2 day(s).');
    expect((await runs(['--since', '40'])).stdout).toContain('o/r#1');
  });

  it('prints the rows and the totals as JSON', async () => {
    seed(record());

    const { stdout } = await runs(['--json', '--since', '3']);
    const body = JSON.parse(stdout);

    expect(body.days).toBe(3);
    expect(body.totals).toEqual({ count: 1, minutes: 8, costUsd: 1.2 });
    expect(body.runs).toHaveLength(1);
    expect(body.runs[0]).toMatchObject({ prId: 'o/r#1', phase: 'prepare', outcome: 'prepared', model: 'claude-x', turns: 12 });
  });

  it('refuses a window that is not a number of days', async () => {
    expect((await runs(['--since', 'ages'])).code).toBe(1);
  });
});
