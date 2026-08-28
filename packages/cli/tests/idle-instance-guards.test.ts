import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

let root: string;
let repoDir: string;
let origCwd: string;

beforeAll(() => {
  origCwd = process.cwd();
  root = mkdtempSync(join(tmpdir(), 'diffity-instance-guards-'));
  repoDir = join(root, 'repo');
  mkdirSync(repoDir);
  execFileSync('git', ['init', '-b', 'main', repoDir], { stdio: 'pipe' });
  execFileSync('git', ['config', 'user.email', 't@t'], { cwd: repoDir, stdio: 'pipe' });
  execFileSync('git', ['config', 'user.name', 'T'], { cwd: repoDir, stdio: 'pipe' });
  writeFileSync(join(repoDir, 'a.ts'), 'const a = 1;\n');
  execFileSync('git', ['add', '.'], { cwd: repoDir, stdio: 'pipe' });
  execFileSync('git', ['commit', '-m', 'init'], { cwd: repoDir, stdio: 'pipe' });
  writeFileSync(join(repoDir, 'a.ts'), 'const a = 2;\n');
  process.env.DIFFITY_DATA_DIR = join(root, 'notes');
  process.chdir(repoDir);
});

afterAll(() => {
  process.chdir(origCwd);
  delete process.env.DIFFITY_DATA_DIR;
  rmSync(root, { recursive: true, force: true });
});

// An agent parks on the session the reader is viewing — the tree, or a review carried forward by
// a commit — which is not necessarily the session the server was started for. The shutdown guard
// therefore has to ask about the whole instance, or it stops the server under work it never saw.
describe('a server judging whether it is still needed', () => {
  it('counts a review in progress on any session of this checkout', async () => {
    const { findOrCreateSession } = await import('../src/session.js');
    const { getRepoRoot } = await import('@diffity/git');
    const { startReviewRun, finishReviewRun, anyReviewInProgress } = await import('../src/review-run.js');
    const { shouldShutDown } = await import('../src/idle-shutdown.js');

    // The reader moved to the tree; the review runs on the tree session, not the startup one.
    findOrCreateSession('work');
    const tree = findOrCreateSession('__tree__');
    startReviewRun(tree.id, 'half way through');

    const facts = {
      viewerGone: true,
      everSeen: true,
      idleForMs: 10 * 60_000,
      listeners: 0,
      reviewInProgress: anyReviewInProgress(getRepoRoot()),
    };

    expect(facts.reviewInProgress).toBe(true);
    expect(shouldShutDown(facts)).toBe(false);

    finishReviewRun(tree.id);
    expect(anyReviewInProgress(getRepoRoot())).toBe(false);
    expect(shouldShutDown({ ...facts, reviewInProgress: false })).toBe(true);
  });

  it('counts a listener parked on any session, not only the startup one', async () => {
    const { findOrCreateSession } = await import('../src/session.js');
    const { waitForLiveRequest, liveListenerTotal } = await import('../src/live.js');
    const { shouldShutDown } = await import('../src/idle-shutdown.js');

    const tree = findOrCreateSession('__tree__');
    const abort = new AbortController();
    const waiting = waitForLiveRequest(tree.id, 5_000, abort.signal);

    expect(liveListenerTotal()).toBe(1);
    expect(
      shouldShutDown({
        viewerGone: true,
        everSeen: true,
        idleForMs: 10 * 60_000,
        listeners: liveListenerTotal(),
        reviewInProgress: false,
      }),
    ).toBe(false);

    abort.abort();
    await waiting;
    expect(liveListenerTotal()).toBe(0);
  });
});
