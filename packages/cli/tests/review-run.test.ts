import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

let root: string;
let repoDir: string;
let origCwd: string;

function commit(name: string): void {
  writeFileSync(join(repoDir, name), `${name}\n`);
  execFileSync('git', ['add', '.'], { cwd: repoDir, stdio: 'pipe' });
  execFileSync('git', ['commit', '-m', name], { cwd: repoDir, stdio: 'pipe' });
}

beforeAll(() => {
  origCwd = process.cwd();
  root = mkdtempSync(join(tmpdir(), 'diffity-run-'));
  repoDir = join(root, 'repo');
  execFileSync('git', ['init', '-b', 'main', repoDir], { stdio: 'pipe' });
  execFileSync('git', ['config', 'user.email', 't@t'], { cwd: repoDir, stdio: 'pipe' });
  execFileSync('git', ['config', 'user.name', 'T'], { cwd: repoDir, stdio: 'pipe' });
  commit('a.txt');
  process.env.DIFFITY_DATA_DIR = join(root, 'notes');
  process.chdir(repoDir);
});

afterAll(() => {
  process.chdir(origCwd);
  delete process.env.DIFFITY_DATA_DIR;
  rmSync(root, { recursive: true, force: true });
});

describe('a review run', () => {
  it('is absent until one starts', async () => {
    const { getReviewRun } = await import('../src/review-run.js');
    const { findOrCreateSession } = await import('../src/session.js');

    expect(getReviewRun(findOrCreateSession('work').id).inProgress).toBe(false);
  });

  it('is in progress once started, carrying its note', async () => {
    const { getReviewRun, startReviewRun } = await import('../src/review-run.js');
    const { findOrCreateSession } = await import('../src/session.js');
    const session = findOrCreateSession('work');

    startReviewRun(session.id, 'reading the idempotency change');
    const run = getReviewRun(session.id);

    expect(run.inProgress).toBe(true);
    expect(run.note).toBe('reading the idempotency change');
    expect(run.startedAt).toBeTruthy();
  });

  it('stops being in progress when it finishes', async () => {
    const { getReviewRun, startReviewRun, finishReviewRun } = await import('../src/review-run.js');
    const { findOrCreateSession } = await import('../src/session.js');
    const session = findOrCreateSession('work');

    startReviewRun(session.id, '');
    finishReviewRun(session.id);

    expect(getReviewRun(session.id).inProgress).toBe(false);
  });

  it('keeps one run per session when started twice', async () => {
    const { getReviewRun, startReviewRun } = await import('../src/review-run.js');
    const { findOrCreateSession } = await import('../src/session.js');
    const session = findOrCreateSession('work');

    startReviewRun(session.id, 'first');
    startReviewRun(session.id, 'second');

    expect(getReviewRun(session.id).note).toBe('second');
    expect(getReviewRun(session.id).inProgress).toBe(true);
  });

  it('follows the session when a commit moves HEAD mid-review', async () => {
    const { getReviewRun, startReviewRun } = await import('../src/review-run.js');
    const { findOrCreateSession } = await import('../src/session.js');
    const before = findOrCreateSession('work');
    startReviewRun(before.id, 'still going');

    commit('b.txt');
    const after = findOrCreateSession('work');

    expect(after.id).not.toBe(before.id);
    expect(getReviewRun(after.id).inProgress).toBe(true);
    expect(getReviewRun(after.id).note).toBe('still going');
  });

  it('does not resurrect a finished run on a later session', async () => {
    const { getReviewRun, startReviewRun, finishReviewRun } = await import('../src/review-run.js');
    const { findOrCreateSession } = await import('../src/session.js');
    const before = findOrCreateSession('work');
    startReviewRun(before.id, 'done with this');
    finishReviewRun(before.id);

    commit('c.txt');
    const after = findOrCreateSession('work');

    expect(getReviewRun(after.id).inProgress).toBe(false);
  });
});
