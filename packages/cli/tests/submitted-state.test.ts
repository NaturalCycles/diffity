import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

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
