import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

let root: string;
let repoDir: string;
let origCwd: string;

function git(args: string[]): string {
  return execFileSync('git', args, { cwd: repoDir, encoding: 'utf-8', stdio: 'pipe' }).trim();
}

const agent = { name: 'Agent', type: 'agent' as const };
const BODY = 'export const LIMIT = 5;\n';

beforeAll(() => {
  origCwd = process.cwd();
  root = mkdtempSync(join(tmpdir(), 'diffity-rename-'));
  repoDir = join(root, 'repo');
  execFileSync('git', ['init', '-b', 'main', repoDir], { stdio: 'pipe' });
  git(['config', 'user.email', 't@t']);
  git(['config', 'user.name', 'T']);
  writeFileSync(join(repoDir, 'base.txt'), 'base\n');
  git(['add', '.']);
  git(['commit', '-m', 'init']);
  git(['branch', 'base']);
  process.env.DIFFITY_DATA_DIR = join(root, 'notes');
  process.chdir(repoDir);
});

afterAll(() => {
  process.chdir(origCwd);
  delete process.env.DIFFITY_DATA_DIR;
  rmSync(root, { recursive: true, force: true });
});

// What bit: a finding written against `scripts/medical/const.ts`, then a commit that renames the
// file. The thread carries forward and keeps the old path, which nothing in the page renders.
describe('a finding on a file that a later commit renames', () => {
  it('moves to the path the file now has', async () => {
    const { findOrCreateSession } = await import('../src/session.js');
    const { createThread, getThreadsForSession } = await import('../src/threads.js');

    writeFileSync(join(repoDir, 'old-name.ts'), BODY);
    git(['add', '.']);
    git(['commit', '-m', 'add the file']);

    const before = findOrCreateSession('base');
    const finding = createThread(before.id, 'old-name.ts', 'new', 1, 1, 'P2: magic number', agent, BODY.trim());
    expect(getThreadsForSession(before.id)[0].filePath).toBe('old-name.ts');

    git(['mv', 'old-name.ts', 'new-name.ts']);
    git(['commit', '-m', 'rename it']);

    const after = findOrCreateSession('base');

    expect(after.id).not.toBe(before.id);
    const carried = getThreadsForSession(after.id).find(t => t.id === finding.id);
    expect(carried).toBeDefined();
    expect(carried!.filePath).toBe('new-name.ts');
  });

  it('leaves a finding on a file nothing renamed where it is', async () => {
    const { findOrCreateSession } = await import('../src/session.js');
    const { createThread, getThreadsForSession } = await import('../src/threads.js');

    const before = findOrCreateSession('base');
    const finding = createThread(before.id, 'base.txt', 'new', 1, 1, 'P3: a note', agent, 'base');

    writeFileSync(join(repoDir, 'another.ts'), 'x\n');
    git(['add', '.']);
    git(['commit', '-m', 'unrelated']);

    const after = findOrCreateSession('base');
    const carried = getThreadsForSession(after.id).find(t => t.id === finding.id);

    expect(carried!.filePath).toBe('base.txt');
  });
});
