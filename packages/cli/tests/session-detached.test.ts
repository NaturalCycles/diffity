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

function commit(name: string, body: string): string {
  writeFileSync(join(repoDir, name), body);
  git(['add', '.']);
  git(['commit', '-m', name]);
  return git(['rev-parse', 'HEAD']);
}

const agent = { name: 'Agent', type: 'agent' as const };

beforeAll(() => {
  origCwd = process.cwd();
  root = mkdtempSync(join(tmpdir(), 'diffity-detached-'));
  repoDir = join(root, 'repo');
  execFileSync('git', ['init', '-b', 'main', repoDir], { stdio: 'pipe' });
  git(['config', 'user.email', 't@t']);
  git(['config', 'user.name', 'T']);
  commit('a.txt', 'a\n');
  process.env.DIFFITY_DATA_DIR = join(root, 'notes');
  process.chdir(repoDir);
});

afterAll(() => {
  process.chdir(origCwd);
  delete process.env.DIFFITY_DATA_DIR;
  rmSync(root, { recursive: true, force: true });
});

describe('a detached checkout, which is how a reviewer opens somebody else pull request', () => {
  it('does not record HEAD as though it were a branch', async () => {
    const { findOrCreateSession } = await import('../src/session.js');
    const { getDb } = await import('../src/db.js');

    const head = git(['rev-parse', 'HEAD']);
    git(['checkout', '--detach', head]);
    const session = findOrCreateSession('detached-base');
    const row = getDb()
      .prepare('SELECT branch FROM review_sessions WHERE id = ?')
      .get(session.id) as { branch: string | null };

    expect(row.branch).toBeNull();
    git(['checkout', 'main']);
  });

  // The sequence that stranded findings: diffity runs on a detached worktree, then PR mode calls
  // `gh pr checkout` and the next run is on a real branch. Recorded as a branch called HEAD, the
  // first session matched neither the detached run nor the one after it.
  it('keeps its findings once the checkout lands on a real branch', async () => {
    const { findOrCreateSession } = await import('../src/session.js');
    const { createThread, getThreadsForSession } = await import('../src/threads.js');

    git(['checkout', '--detach', git(['rev-parse', 'HEAD'])]);
    const whileDetached = findOrCreateSession('handover-base');
    const finding = createThread(whileDetached.id, 'a.txt', 'new', 1, 1, 'found while detached', agent);

    git(['checkout', '-b', 'pr-branch']);
    const onBranch = findOrCreateSession('handover-base');

    // Same commit and same base, so the branchless row is adopted in place rather than superseded.
    expect(onBranch.id).toBe(whileDetached.id);
    expect(getThreadsForSession(onBranch.id).map(t => t.id)).toContain(finding.id);
    git(['checkout', 'main']);
  });

  it('carries them forward when the commit moves under it as well', async () => {
    const { findOrCreateSession } = await import('../src/session.js');
    const { createThread, getThreadsForSession } = await import('../src/threads.js');

    git(['checkout', '--detach', git(['rev-parse', 'HEAD'])]);
    const before = findOrCreateSession('moving-base');
    const finding = createThread(before.id, 'a.txt', 'new', 1, 1, 'found before the commit moved', agent);

    git(['checkout', '-B', 'moved-branch']);
    commit('d.txt', 'd\n');
    const after = findOrCreateSession('moving-base');

    expect(after.id).not.toBe(before.id);
    expect(getThreadsForSession(after.id).map(t => t.id)).toContain(finding.id);
    git(['checkout', 'main']);
  });

  // What swallowed a whole review: with no branch, every base ref shares one scope, so a session
  // opened for a second pull request looked like the same review continuing.
  it('does not take the findings of a different review in the same checkout', async () => {
    const { findOrCreateSession } = await import('../src/session.js');
    const { createThread, getThreadsForSession } = await import('../src/threads.js');

    const firstBase = commit('b.txt', 'b\n');
    git(['checkout', '--detach', firstBase]);
    const reviewOne = findOrCreateSession(firstBase);
    const finding = createThread(reviewOne.id, 'a.txt', 'new', 1, 1, 'belongs to review one', agent);

    git(['checkout', 'main']);
    const secondBase = commit('c.txt', 'c\n');
    git(['checkout', '--detach', secondBase]);
    const reviewTwo = findOrCreateSession(secondBase);

    expect(reviewTwo.id).not.toBe(reviewOne.id);
    expect(getThreadsForSession(reviewTwo.id).map(t => t.id)).not.toContain(finding.id);
    expect(getThreadsForSession(reviewOne.id).map(t => t.id)).toContain(finding.id);
    git(['checkout', 'main']);
  });
});
