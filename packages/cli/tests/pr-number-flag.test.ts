import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { InvalidArgumentError } from 'commander';
import { execFileSync, spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, realpathSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { pullRequestNumber } from '../src/pr-number.js';

const ENTRY = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist', 'index.js');

describe('what --pr accepts', () => {
  it('takes a positive whole number, however written', () => {
    expect(pullRequestNumber('14502')).toBe(14502);
    expect(pullRequestNumber('1e2')).toBe(100);
  });

  it('rejects everything else with the raw input left to commander', () => {
    for (const raw of ['0', '-1', '4.5', '42abc', 'abc', '']) {
      expect(() => pullRequestNumber(raw)).toThrowError(InvalidArgumentError);
    }
  });
});

describe('--pr on the command line', () => {
  let root: string;
  /** A repository with a GitHub remote, as a pull request's checkout has. */
  let repo: string;
  /** One without any remote. */
  let plain: string;

  function initRepo(dir: string): void {
    mkdirSync(dir);
    execFileSync('git', ['init', '-b', 'main', dir], { stdio: 'pipe' });
    execFileSync('git', ['config', 'user.email', 't@t'], { cwd: dir, stdio: 'pipe' });
    execFileSync('git', ['config', 'user.name', 'T'], { cwd: dir, stdio: 'pipe' });
    writeFileSync(join(dir, 'a.ts'), 'const a = 1;\n');
    execFileSync('git', ['add', '.'], { cwd: dir, stdio: 'pipe' });
    execFileSync('git', ['commit', '-m', 'init'], { cwd: dir, stdio: 'pipe' });
  }

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'diffity-pr-flag-'));
    repo = join(root, 'repo');
    plain = join(root, 'plain');
    initRepo(repo);
    initRepo(plain);
    execFileSync('git', ['remote', 'add', 'origin', 'git@github.com:o/r.git'], { cwd: repo, stdio: 'pipe' });
  });

  afterAll(() => { rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); });

  /** Waits for a server told to stop to be gone, so the directory it writes into can be removed. */
  function exited(child: ChildProcess, ms = 5000): Promise<void> {
    return new Promise(resolve => {
      if (child.exitCode !== null || child.signalCode !== null) {
        resolve();
        return;
      }
      const timer = setTimeout(resolve, ms);
      child.once('exit', () => { clearTimeout(timer); resolve(); });
    });
  }

  const env = () => ({ ...process.env, DIFFITY_DATA_DIR: join(root, 'data') });

  function run(dir: string, args: string[]) {
    return spawnSync(process.execPath, [ENTRY, '--repo', dir, '--no-open', ...args], { encoding: 'utf-8', env: env() });
  }

  /** Starts a server on a free port and resolves with it once it has registered. */
  async function start(args: string[]): Promise<{ child: ChildProcess; port: number; ref: string }> {
    const child = spawn(process.execPath, [ENTRY, '--repo', repo, '--no-open', '--quiet', '--port', '0', ...args], { env: env(), stdio: 'ignore' });
    const registry = join(root, 'data', 'registry.json');
    const repoRoot = realpathSync(repo);
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
      if (existsSync(registry)) {
        const entry = (JSON.parse(readFileSync(registry, 'utf-8')) as { repoRoot: string; port: number; ref: string }[])
          .find(e => e.repoRoot === repoRoot);
        if (entry) {
          return { child, port: entry.port, ref: entry.ref };
        }
      }
      if (child.exitCode !== null) {
        throw new Error(`the server exited with ${child.exitCode} before registering`);
      }
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    child.kill('SIGTERM');
    throw new Error('the server did not register in time');
  }

  it('needs the commit the pull request is based on', () => {
    const noRef = run(repo, ['--pr', '7']);
    expect(noRef.status).toBe(1);
    expect(noRef.stderr).toContain('--pr needs the commit the pull request is based on');

    const workingTree = run(repo, ['--pr', '7', 'work']);
    expect(workingTree.status).toBe(1);
    expect(workingTree.stderr).toContain('--pr needs the commit the pull request is based on');
  });

  it('refuses a number that is not one', () => {
    const bad = run(repo, ['--pr', 'seven', 'HEAD']);
    expect(bad.status).not.toBe(0);
    expect(bad.stderr).toContain('A pull request number is a positive integer');
  });

  it('refuses a repository with no GitHub remote, where the number could show nothing', () => {
    const noRemote = run(plain, ['--pr', '7', 'HEAD']);
    expect(noRemote.status).toBe(1);
    expect(noRemote.stderr).toContain('No GitHub remote detected');
  });

  it('pins /diff to the base it was given', async () => {
    const { child, port } = await start(['--pr', '7', 'HEAD']);
    try {
      const res = await fetch(`http://127.0.0.1:${port}/diff`, { redirect: 'manual' });
      expect(res.status).toBe(302);
      expect(res.headers.get('location')).toBe('/diff?ref=HEAD');
    } finally {
      child.kill('SIGTERM');
      await exited(child);
    }
  }, 30_000);

  it('takes the base as --base too', async () => {
    const { child, ref } = await start(['--pr', '7', '--base', 'HEAD']);
    try {
      expect(ref).toBe('HEAD');
    } finally {
      child.kill('SIGTERM');
      await exited(child);
    }
  }, 30_000);
});
