import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

const ENTRY = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist', 'index.js');

let root: string;
let repo: string;
let origCwd: string;

beforeAll(() => {
  origCwd = process.cwd();
  root = mkdtempSync(join(tmpdir(), 'diffity-cross-session-'));
  repo = join(root, 'repo');
  execFileSync('git', ['init', '-b', 'main', repo], { stdio: 'pipe' });
  execFileSync('git', ['config', 'user.email', 't@t'], { cwd: repo, stdio: 'pipe' });
  execFileSync('git', ['config', 'user.name', 'T'], { cwd: repo, stdio: 'pipe' });
  writeFileSync(join(repo, 'a.ts'), 'const a = 1;\n');
  execFileSync('git', ['add', '.'], { cwd: repo, stdio: 'pipe' });
  execFileSync('git', ['commit', '-m', 'init'], { cwd: repo, stdio: 'pipe' });
  process.env.DIFFITY_DATA_DIR = join(root, 'notes');
  process.chdir(repo);
});

afterAll(() => {
  process.chdir(origCwd);
  delete process.env.DIFFITY_DATA_DIR;
  rmSync(root, { recursive: true, force: true });
});

function cli(args: string[]) {
  return spawnSync(process.execPath, [ENTRY, '--repo', repo, 'agent', ...args], {
    cwd: repo, encoding: 'utf-8', env: { ...process.env, DIFFITY_DATA_DIR: join(root, 'notes') },
  });
}

describe('a thread on another session of the same instance', () => {
  it('takes the agent\'s reply and resolution, since the live queue can hand it one from anywhere', async () => {
    const { findOrCreateSession } = await import('../src/session.js');
    const { createThread, getThread } = await import('../src/threads.js');
    // The thread lives on one session; the agent is parked on another, which is the current one.
    const elsewhere = findOrCreateSession('main');
    const parkedOn = findOrCreateSession('work');
    expect(parkedOn.id).not.toBe(elsewhere.id);
    const thread = createThread(elsewhere.id, 'a.ts', 'new', 1, 1, 'P2: asked over here', { name: 'Agent', type: 'agent' });

    const replied = cli(['reply', thread.id, '--body', 'answered from where the agent sits']);
    // Node 22 prints an ExperimentalWarning for node:sqlite on stderr; only a refusal matters here.
    expect(replied.stderr).not.toContain('Error');
    expect(replied.status).toBe(0);
    expect(replied.stdout).toContain('Replied to thread');
    expect(getThread(thread.id)!.comments.map(comment => comment.body)).toEqual(['P2: asked over here', 'answered from where the agent sits']);

    const resolved = cli(['resolve', thread.id, '--summary', 'done']);
    expect(resolved.status).toBe(0);
    expect(getThread(thread.id)!.status).toBe('resolved');
    expect(getThread(thread.id)!.sessionId).toBe(elsewhere.id);
  });
});
