import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

let root: string;
let repoDir: string;
let otherRepo: string;
let origCwd: string;

function makeRepo(path: string): void {
  execFileSync('git', ['init', '-b', 'main', path], { stdio: 'pipe' });
  execFileSync('git', ['config', 'user.email', 't@t'], { cwd: path, stdio: 'pipe' });
  execFileSync('git', ['config', 'user.name', 'T'], { cwd: path, stdio: 'pipe' });
  writeFileSync(join(path, 'a.txt'), 'a\n');
  execFileSync('git', ['add', '.'], { cwd: path, stdio: 'pipe' });
  execFileSync('git', ['commit', '-m', 'init'], { cwd: path, stdio: 'pipe' });
}

function git(args: string[]): string {
  return execFileSync('git', args, { cwd: repoDir, encoding: 'utf-8', stdio: 'pipe' }).trim();
}

const agent = { name: 'Agent', type: 'agent' as const };

beforeAll(() => {
  origCwd = process.cwd();
  root = mkdtempSync(join(tmpdir(), 'diffity-base-change-'));
  repoDir = join(root, 'repo');
  otherRepo = join(root, 'other');
  makeRepo(repoDir);
  makeRepo(otherRepo);
  process.env.DIFFITY_DATA_DIR = join(root, 'notes');
  process.chdir(repoDir);
});

afterAll(() => {
  process.chdir(origCwd);
  delete process.env.DIFFITY_DATA_DIR;
  rmSync(root, { recursive: true, force: true });
});

/**
 * Updating a branch from its base is routine, and it changes the base the diff is taken against.
 * The review is the same review either way, so the findings have to come along.
 */
describe('a review whose base changes under it', () => {
  it('brings open findings along', async () => {
    const { findOrCreateSession } = await import('../src/session.js');
    const { createThread, getThreadsForSession } = await import('../src/threads.js');

    const before = findOrCreateSession('base-one');
    const finding = createThread(before.id, 'a.txt', 'new', 1, 1, 'P2: still open', agent);

    const after = findOrCreateSession('base-two');

    expect(getThreadsForSession(after.id).map(t => t.id)).toContain(finding.id);
  });

  it('brings them back when the base changes again', async () => {
    const { findOrCreateSession } = await import('../src/session.js');
    const { createThread, getThreadsForSession } = await import('../src/threads.js');

    const first = findOrCreateSession('flip-one');
    const finding = createThread(first.id, 'a.txt', 'new', 1, 1, 'P2: about a.txt', agent);

    findOrCreateSession('flip-two');
    const back = findOrCreateSession('flip-one');

    // Reusing an earlier session must not hand back the empty shell the findings moved out of.
    expect(getThreadsForSession(back.id).map(t => t.id)).toContain(finding.id);
  });

  it('brings walkthroughs along', async () => {
    const { findOrCreateSession } = await import('../src/session.js');
    const { createTour, getToursForSession } = await import('../src/tours.js');

    const before = findOrCreateSession('tour-base-one');
    const tour = createTour(before.id, 'Reading order', '');

    const after = findOrCreateSession('tour-base-two');

    expect(getToursForSession(after.id).map(t => t.id)).toContain(tour.id);
  });

  it('leaves a resolved finding with the commit that dealt with it', async () => {
    const { findOrCreateSession } = await import('../src/session.js');
    const { createThread, getThreadsForSession, updateThreadStatus } = await import('../src/threads.js');

    const before = findOrCreateSession('closed-base-one');
    const dealtWith = createThread(before.id, 'a.txt', 'new', 1, 1, 'P3: fixed', agent);
    updateThreadStatus(dealtWith.id, 'resolved');

    const after = findOrCreateSession('closed-base-two');

    expect(getThreadsForSession(after.id).map(t => t.id)).not.toContain(dealtWith.id);
    expect(getThreadsForSession(before.id).map(t => t.id)).toContain(dealtWith.id);
  });

  it('redirects a tab that loaded before the base changed', async () => {
    const { findOrCreateSession, resolveSessionId } = await import('../src/session.js');

    const loadedWith = findOrCreateSession('tab-base-one');
    const current = findOrCreateSession('tab-base-two');

    expect(resolveSessionId(loadedWith.id)).toBe(current.id);
  });
});

describe('what a review does not follow', () => {
  it('does not follow the checkout onto another branch', async () => {
    const { findOrCreateSession } = await import('../src/session.js');
    const { createThread, getThreadsForSession } = await import('../src/threads.js');

    const onMain = findOrCreateSession('branch-base');
    const finding = createThread(onMain.id, 'a.txt', 'new', 1, 1, 'P2: about main', agent);

    git(['checkout', '-b', 'other-branch']);
    const onOther = findOrCreateSession('branch-base');

    expect(onOther.id).not.toBe(onMain.id);
    expect(getThreadsForSession(onOther.id).map(t => t.id)).not.toContain(finding.id);

    git(['checkout', 'main']);
  });

  it('does not follow into another repository', async () => {
    const { findOrCreateSession } = await import('../src/session.js');
    const { createThread, getThreadsForSession } = await import('../src/threads.js');

    const here = findOrCreateSession('shared-base');
    const finding = createThread(here.id, 'a.txt', 'new', 1, 1, 'P2: about this repo', agent);

    process.chdir(otherRepo);
    const there = findOrCreateSession('shared-base');
    process.chdir(repoDir);

    expect(getThreadsForSession(there.id).map(t => t.id)).not.toContain(finding.id);
  });

  // Reviewing what you have not committed is a different activity from reviewing a branch, and
  // the two do not even cover the same lines.
  it('keeps the working tree and a base comparison apart', async () => {
    const { findOrCreateSession } = await import('../src/session.js');
    const { createThread, getThreadsForSession } = await import('../src/threads.js');

    const inWorkingTree = findOrCreateSession('work');
    const finding = createThread(inWorkingTree.id, 'a.txt', 'new', 1, 1, 'P2: uncommitted', agent);

    const againstBase = findOrCreateSession('some-base');

    expect(getThreadsForSession(againstBase.id).map(t => t.id)).not.toContain(finding.id);
  });

  it('keeps the file browser apart from a diff review', async () => {
    const { findOrCreateSession } = await import('../src/session.js');
    const { createThread, getThreadsForSession } = await import('../src/threads.js');

    const browsing = findOrCreateSession('__tree__');
    const note = createThread(browsing.id, 'a.txt', 'new', 1, 1, 'a note while browsing', agent);

    const reviewing = findOrCreateSession('review-base');

    expect(getThreadsForSession(reviewing.id).map(t => t.id)).not.toContain(note.id);
    expect(getThreadsForSession(browsing.id).map(t => t.id)).toContain(note.id);
  });
});

describe('a session written before sessions recorded their branch', () => {
  it('is adopted rather than stranded when the base changes', async () => {
    const { findOrCreateSession } = await import('../src/session.js');
    const { createThread, getThreadsForSession } = await import('../src/threads.js');
    const { getDb } = await import('../src/db.js');

    const legacy = findOrCreateSession('legacy-base-one');
    const finding = createThread(legacy.id, 'a.txt', 'new', 1, 1, 'written before the upgrade', agent);
    // What the database looks like for a session written by a build that did not know about branches.
    getDb().prepare('UPDATE review_sessions SET branch = NULL WHERE id = ?').run(legacy.id);

    const afterUpgrade = findOrCreateSession('legacy-base-two');

    expect(getThreadsForSession(afterUpgrade.id).map(t => t.id)).toContain(finding.id);
  });

  it('is reused rather than duplicated when opened with the same base', async () => {
    const { findOrCreateSession } = await import('../src/session.js');
    const { getDb } = await import('../src/db.js');

    const legacy = findOrCreateSession('legacy-same-base');
    getDb().prepare('UPDATE review_sessions SET branch = NULL WHERE id = ?').run(legacy.id);

    const again = findOrCreateSession('legacy-same-base');

    expect(again.id).toBe(legacy.id);
  });
});

describe('findings stranded by an earlier build', () => {
  it('are gathered up from every session they were left in', async () => {
    const { findOrCreateSession } = await import('../src/session.js');
    const { createThread, getThreadsForSession } = await import('../src/threads.js');

    // Three bases in turn, each leaving a finding behind under the old behaviour.
    const first = findOrCreateSession('gather-one');
    const a = createThread(first.id, 'a.txt', 'new', 1, 1, 'P2: from the first base', agent);
    const second = findOrCreateSession('gather-two');
    const b = createThread(second.id, 'a.txt', 'new', 1, 1, 'P2: from the second base', agent);

    const third = findOrCreateSession('gather-three');
    const here = getThreadsForSession(third.id).map(t => t.id);

    expect(here).toContain(a.id);
    expect(here).toContain(b.id);
  });

  it('does not bring a finished review run back to life', async () => {
    const { findOrCreateSession } = await import('../src/session.js');
    const { getReviewRun, startReviewRun, finishReviewRun } = await import('../src/review-run.js');

    const first = findOrCreateSession('run-base-one');
    startReviewRun(first.id, 'reviewing against the first base');
    finishReviewRun(first.id);

    const second = findOrCreateSession('run-base-two');

    expect(getReviewRun(second.id).inProgress).toBe(false);
  });

  it('carries a review still under way across the change of base', async () => {
    const { findOrCreateSession } = await import('../src/session.js');
    const { getReviewRun, startReviewRun } = await import('../src/review-run.js');

    const first = findOrCreateSession('live-run-base-one');
    startReviewRun(first.id, 'still going');

    const second = findOrCreateSession('live-run-base-two');

    expect(getReviewRun(second.id).inProgress).toBe(true);
    expect(getReviewRun(second.id).note).toBe('still going');
  });
});
