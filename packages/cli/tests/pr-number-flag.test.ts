import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { InvalidArgumentError } from 'commander';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
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
  let repo: string;

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'diffity-pr-flag-'));
    repo = join(root, 'repo');
    mkdirSync(repo);
    execFileSync('git', ['init', '-b', 'main', repo], { stdio: 'pipe' });
    execFileSync('git', ['config', 'user.email', 't@t'], { cwd: repo, stdio: 'pipe' });
    execFileSync('git', ['config', 'user.name', 'T'], { cwd: repo, stdio: 'pipe' });
    writeFileSync(join(repo, 'a.ts'), 'const a = 1;\n');
    execFileSync('git', ['add', '.'], { cwd: repo, stdio: 'pipe' });
    execFileSync('git', ['commit', '-m', 'init'], { cwd: repo, stdio: 'pipe' });
  });

  afterAll(() => { rmSync(root, { recursive: true, force: true }); });

  function run(args: string[]) {
    return spawnSync(process.execPath, [ENTRY, '--repo', repo, '--no-open', ...args], {
      encoding: 'utf-8', env: { ...process.env, DIFFITY_DATA_DIR: join(root, 'data') },
    });
  }

  it('needs the commit the pull request is based on', () => {
    const noRef = run(['--pr', '7']);
    expect(noRef.status).toBe(1);
    expect(noRef.stderr).toContain('--pr needs the commit the pull request is based on');

    const workingTree = run(['--pr', '7', 'work']);
    expect(workingTree.status).toBe(1);
    expect(workingTree.stderr).toContain('--pr needs the commit the pull request is based on');
  });

  it('refuses a number that is not one', () => {
    const bad = run(['--pr', 'seven', 'HEAD']);
    expect(bad.status).not.toBe(0);
    expect(bad.stderr).toContain('A pull request number is a positive integer');
  });
});
