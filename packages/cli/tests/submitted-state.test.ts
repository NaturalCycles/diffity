import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

const DIST_ENTRY = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist', 'index.js');

let root: string;
let repoDir: string;
let origCwd: string;

beforeAll(() => {
  origCwd = process.cwd();
  root = mkdtempSync(join(tmpdir(), 'diffity-submitted-'));
  repoDir = join(root, 'repo');
  execFileSync('git', ['init', '-b', 'main', repoDir], { stdio: 'pipe' });
  execFileSync('git', ['config', 'user.email', 't@t'], { cwd: repoDir, stdio: 'pipe' });
  execFileSync('git', ['config', 'user.name', 'T'], { cwd: repoDir, stdio: 'pipe' });
  writeFileSync(join(repoDir, 'a.ts'), 'const a = 1;\n');
  execFileSync('git', ['add', '.'], { cwd: repoDir, stdio: 'pipe' });
  execFileSync('git', ['commit', '-m', 'init'], { cwd: repoDir, stdio: 'pipe' });
  process.env.DIFFITY_DATA_DIR = join(root, 'notes');
  process.chdir(repoDir);
});

afterAll(() => {
  process.chdir(origCwd);
  delete process.env.DIFFITY_DATA_DIR;
  rmSync(root, { recursive: true, force: true });
});

async function newThread(body: string) {
  const { findOrCreateSession } = await import('../src/session.js');
  const { createThread } = await import('../src/threads.js');
  const session = findOrCreateSession('work');
  return createThread(session.id, 'a.ts', 'new', 1, 1, body, { name: 'Agent', type: 'agent' });
}

describe('a thread that has been sent to the forge', () => {
  it('records the forge comment id it went out as', async () => {
    const { markThreadsSubmitted, getThread } = await import('../src/threads.js');
    const thread = await newThread('P2: sent with an id');

    markThreadsSubmitted([{ threadId: thread.id, githubCommentId: 900 }]);

    expect(getThread(thread.id)?.githubCommentId).toBe(900);
  });

  it('keeps the recorded id when a later submit learns none', async () => {
    const { markThreadsSubmitted, getThread } = await import('../src/threads.js');
    const thread = await newThread('P2: sent twice');

    markThreadsSubmitted([{ threadId: thread.id, githubCommentId: 900 }]);
    markThreadsSubmitted([thread.id]);

    expect(getThread(thread.id)?.githubCommentId).toBe(900);
  });

  it('starts out unsent', async () => {
    const thread = await newThread('P2: not sent yet');

    expect(thread.submittedAt).toBeNull();
  });

  it('records when it was sent', async () => {
    const { markThreadsSubmitted, getThread } = await import('../src/threads.js');
    const thread = await newThread('P2: about to be sent');

    markThreadsSubmitted([thread.id]);

    expect(getThread(thread.id)?.submittedAt).toBeTruthy();
  });

  it('leaves other threads alone', async () => {
    const { markThreadsSubmitted, getThread } = await import('../src/threads.js');
    const sent = await newThread('P2: sent');
    const kept = await newThread('P2: kept back');

    markThreadsSubmitted([sent.id]);

    expect(getThread(sent.id)?.submittedAt).toBeTruthy();
    expect(getThread(kept.id)?.submittedAt).toBeNull();
  });

  it('is still open, because sending is not resolving', async () => {
    const { markThreadsSubmitted, getThread } = await import('../src/threads.js');
    const thread = await newThread('P2: sent but unresolved');

    markThreadsSubmitted([thread.id]);

    expect(getThread(thread.id)?.status).toBe('open');
  });

  it('ignores an empty list rather than marking everything', async () => {
    const { markThreadsSubmitted, getThread } = await import('../src/threads.js');
    const thread = await newThread('P2: untouched');

    markThreadsSubmitted([]);

    expect(getThread(thread.id)?.submittedAt).toBeNull();
  });
});

describe('what a sent thread remembers about the review', () => {
  it('records the review it went out in and the commit it went out against', async () => {
    const { markThreadsSubmitted, getThread } = await import('../src/threads.js');
    const thread = await newThread('P2: sent with provenance');

    markThreadsSubmitted([thread.id], {
      reviewUrl: 'https://github.com/o/r/pull/1#pullrequestreview-9',
      headSha: 'abc1234',
    });

    const sent = getThread(thread.id);
    expect(sent?.submittedReviewUrl).toBe('https://github.com/o/r/pull/1#pullrequestreview-9');
    expect(sent?.submittedHeadSha).toBe('abc1234');
  });

  // The question a reviewer actually asks after a push is "did this go out against the code that
  // is there now?", which needs the sha, not just a timestamp.
  it('still marks the thread when the forge told us neither', async () => {
    const { markThreadsSubmitted, getThread } = await import('../src/threads.js');
    const thread = await newThread('P2: sent without provenance');

    markThreadsSubmitted([thread.id]);

    const sent = getThread(thread.id);
    expect(sent?.submittedAt).toBeTruthy();
    expect(sent?.submittedReviewUrl).toBeNull();
    expect(sent?.submittedHeadSha).toBeNull();
  });
});

describe('the daemon marking what it posted itself', () => {
  /** `diffity agent mark-posted`, run the way the daemon runs it: the built CLI, in the checkout. */
  function markPosted(args: string[]): Promise<{ code: number | null; stdout: string; stderr: string }> {
    return new Promise(resolve => {
      const child = spawn(process.execPath, [DIST_ENTRY, 'agent', 'mark-posted', ...args], {
        cwd: repoDir, stdio: ['ignore', 'pipe', 'pipe'], env: process.env,
      });
      let stdout = '';
      let stderr = '';
      child.stdout.setEncoding('utf-8');
      child.stderr.setEncoding('utf-8');
      child.stdout.on('data', chunk => { stdout += chunk; });
      child.stderr.on('data', chunk => { stderr += chunk; });
      child.on('close', code => resolve({ code, stdout, stderr }));
    });
  }

  it('marks each named thread, by its printed prefix or in full, with the comment it went out as', async () => {
    const { getThread } = await import('../src/threads.js');
    const withId = await newThread('P1: posted with an id');
    const withoutId = await newThread('P1: posted without one');
    const untouched = await newThread('P2: nobody posted this');

    const { code, stdout } = await markPosted([
      '--review-url', 'https://github.com/o/r/pull/1#pullrequestreview-9',
      '--head-sha', 'abc1234',
      `${withId.id.slice(0, 8)}=901`,
      withoutId.id,
    ]);

    expect(code).toBe(0);
    expect(stdout).toContain('Marked 2 thread(s) as posted');
    expect(getThread(withId.id)).toMatchObject({
      submittedReviewUrl: 'https://github.com/o/r/pull/1#pullrequestreview-9',
      submittedHeadSha: 'abc1234',
      githubCommentId: 901,
    });
    expect(getThread(withoutId.id)?.submittedAt).toBeTruthy();
    expect(getThread(withoutId.id)?.githubCommentId).toBeNull();
    expect(getThread(untouched.id)?.submittedAt).toBeNull();
  });

  it('refuses a thread it cannot find and a comment id that is not one', async () => {
    const thread = await newThread('P1: posted once more');

    const unknown = await markPosted(['--head-sha', 'abc1234', 'ffffffff']);
    expect(unknown.code).toBe(1);
    expect(unknown.stderr).toContain('Thread not found: ffffffff');

    const notAnId = await markPosted(['--head-sha', 'abc1234', `${thread.id}=nine`]);
    expect(notAnId.code).toBe(1);
    expect(notAnId.stderr).toContain('does not name a forge comment id');
  });
});
