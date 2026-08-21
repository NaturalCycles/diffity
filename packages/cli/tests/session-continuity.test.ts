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

function commit(name: string): void {
  writeFileSync(join(repoDir, name), `${name}\n`);
  git(['add', '.']);
  git(['commit', '-m', name]);
}

beforeAll(() => {
  origCwd = process.cwd();
  root = mkdtempSync(join(tmpdir(), 'diffity-session-'));
  repoDir = join(root, 'repo');

  execFileSync('git', ['init', '-b', 'main', repoDir], { stdio: 'pipe' });
  execFileSync('git', ['config', 'user.email', 'test@test.com'], { cwd: repoDir, stdio: 'pipe' });
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: repoDir, stdio: 'pipe' });
  commit('a.txt');

  // Set before anything opens the database, which resolves its path once.
  process.env.DIFFITY_DATA_DIR = join(root, 'notes');
  process.chdir(repoDir);
});

afterAll(() => {
  process.chdir(origCwd);
  delete process.env.DIFFITY_DATA_DIR;
  rmSync(root, { recursive: true, force: true });
});

describe('a session when HEAD moves', () => {
  it('brings open threads and walkthroughs with it, and leaves closed ones behind', async () => {
    const { findOrCreateSession } = await import('../src/session.js');
    const { createThread, getThreadsForSession, updateThreadStatus } = await import('../src/threads.js');
    const { createTour, getToursForSession } = await import('../src/tours.js');

    const first = findOrCreateSession('work');
    const open = createThread(first.id, 'a.txt', 'new', 1, 1, 'P1: still a problem', {
      name: 'Agent',
      type: 'agent',
    });
    const dealtWith = createThread(first.id, 'a.txt', 'new', 2, 2, 'P2: fixed already', {
      name: 'Agent',
      type: 'agent',
    });
    updateThreadStatus(dealtWith.id, 'resolved');
    const tour = createTour(first.id, 'Reading order', '');

    // Acting on a finding is what moves HEAD.
    commit('b.txt');
    const second = findOrCreateSession('work');

    expect(second.id).not.toBe(first.id);

    const carried = getThreadsForSession(second.id);
    expect(carried.map(thread => thread.id)).toEqual([open.id]);
    expect(getToursForSession(second.id).map(t => t.id)).toEqual([tour.id]);

    const left = getThreadsForSession(first.id);
    expect(left.map(thread => thread.id)).toEqual([dealtWith.id]);
  });

  it('follows its code when a later commit moves it', async () => {
    const { findOrCreateSession } = await import('../src/session.js');
    const { createThread, getThreadsForSession } = await import('../src/threads.js');

    writeFileSync(join(repoDir, 'moving.ts'), 'one\ntwo\nthree\n');
    git(['add', '.']);
    git(['commit', '-m', 'moving.ts']);

    const before = findOrCreateSession('work');
    const finding = createThread(
      before.id,
      'moving.ts',
      'new',
      2,
      2,
      'P2: about the second line',
      { name: 'Agent', type: 'agent' },
      'two',
    );

    // Two lines land above it, so the code it points at is now on line 4.
    writeFileSync(join(repoDir, 'moving.ts'), 'inserted\nalso inserted\none\ntwo\nthree\n');
    git(['add', '.']);
    git(['commit', '-m', 'insert above']);

    const after = findOrCreateSession('work');
    const carried = getThreadsForSession(after.id).find(thread => thread.id === finding.id);

    expect(carried?.startLine).toBe(4);
    expect(carried?.endLine).toBe(4);
  });

  it('leaves a finding where it is when its code was edited rather than moved', async () => {
    const { findOrCreateSession } = await import('../src/session.js');
    const { createThread, getThreadsForSession } = await import('../src/threads.js');

    writeFileSync(join(repoDir, 'edited.ts'), 'keep\ntarget\nkeep\n');
    git(['add', '.']);
    git(['commit', '-m', 'edited.ts']);

    const before = findOrCreateSession('work');
    const finding = createThread(
      before.id,
      'edited.ts',
      'new',
      2,
      2,
      'P3: about the target',
      { name: 'Agent', type: 'agent' },
      'target',
    );

    writeFileSync(join(repoDir, 'edited.ts'), 'keep\ntarget changed\nkeep\n');
    git(['add', '.']);
    git(['commit', '-m', 'edit the target']);

    const after = findOrCreateSession('work');
    const carried = getThreadsForSession(after.id).find(thread => thread.id === finding.id);

    expect(carried).toBeDefined();
    expect(carried?.startLine).toBe(2);
  });

  it('returns the same session while HEAD stays put', async () => {
    const { findOrCreateSession } = await import('../src/session.js');

    expect(findOrCreateSession('work').id).toBe(findOrCreateSession('work').id);
  });

  it('keeps refs apart', async () => {
    const { findOrCreateSession } = await import('../src/session.js');

    expect(findOrCreateSession('work').id).not.toBe(findOrCreateSession('main').id);
  });
});
