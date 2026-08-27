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
  root = mkdtempSync(join(tmpdir(), 'diffity-own-session-'));
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

// The ambient `current-session` file is shared by every worktree using one data directory, so a
// server reading it can end up asking about a review that is not its own — and then exit while an
// agent is parked on its own session, or a review of its own is half written.
describe('a server judging whether it is still needed', () => {
  it('asks about its own session, not whichever one was opened last', async () => {
    const { startServer } = await import('../src/server.js');
    const { findOrCreateSession, getCurrentSession } = await import('../src/session.js');
    const { startReviewRun } = await import('../src/review-run.js');
    const { viewerSnapshot, noteViewerSeen, markViewerGone, viewerHasGone, awakeMs } = await import('../src/viewers.js');
    const { shouldShutDown } = await import('../src/idle-shutdown.js');

    // This server's review, with an unfinished run on it.
    const mine = findOrCreateSession('work');
    startReviewRun(mine.id, 'half way through');

    // Another worktree then opens something else, and the ambient file now names that instead.
    const somebodyElse = findOrCreateSession('HEAD~0');
    expect(getCurrentSession()!.id).toBe(somebodyElse.id);
    expect(somebodyElse.id).not.toBe(mine.id);

    const started = await startServer({ port: 0, diffArgs: [], effectiveRef: 'work' });
    try {
      noteViewerSeen();
      markViewerGone();

      const { getReviewRun } = await import('../src/review-run.js');
      // What the server now feeds the policy, taken from its own ref rather than the shared file.
      const facts = {
        viewerGone: viewerHasGone(viewerSnapshot(), awakeMs()),
        everSeen: viewerSnapshot().everSeen,
        idleForMs: 10 * 60_000,
        listeners: 0,
        reviewInProgress: getReviewRun(mine.id).inProgress,
      };

      expect(facts.viewerGone).toBe(true);
      expect(facts.reviewInProgress).toBe(true);
      expect(shouldShutDown(facts)).toBe(false);

      // And the ambient session would have said the opposite, which is the bug.
      expect(getReviewRun(somebodyElse.id).inProgress).toBe(false);
      expect(shouldShutDown({ ...facts, reviewInProgress: false })).toBe(true);
    } finally {
      started.close();
    }
  });
});
