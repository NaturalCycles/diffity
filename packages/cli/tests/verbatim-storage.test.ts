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
  root = mkdtempSync(join(tmpdir(), 'diffity-verbatim-'));
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

const user = { name: 'You', type: 'user' as const };

// The page has no shell in it, so nothing typed there needs unescaping — and unescaping is lossy.
// A comment about `split('\n')` used to reach the database with a real line break in it.
const AS_TYPED = "why not split('\\n') here? the \\\" is deliberate, and \\` too";

describe('text that never went through a shell', () => {
  it('is stored exactly as written', async () => {
    const { findOrCreateSession } = await import('../src/session.js');
    const { createThread, getThread } = await import('../src/threads.js');

    const session = findOrCreateSession('work');
    const thread = createThread(session.id, 'a.ts', 'new', 1, 1, AS_TYPED, user);

    expect(getThread(thread.id)!.comments[0].body).toBe(AS_TYPED);
  });

  it('survives a reply and an edit too', async () => {
    const { findOrCreateSession } = await import('../src/session.js');
    const { createThread, addReply, editComment, getThread } = await import('../src/threads.js');

    const session = findOrCreateSession('work');
    const thread = createThread(session.id, 'a.ts', 'new', 1, 1, 'the finding', user);
    const reply = addReply(thread.id, AS_TYPED, user);
    expect(getThread(thread.id)!.comments[1].body).toBe(AS_TYPED);

    editComment(reply.id, AS_TYPED);
    expect(getThread(thread.id)!.comments[1].body).toBe(AS_TYPED);
  });

  it('keeps a walkthrough step as written', async () => {
    const { findOrCreateSession } = await import('../src/session.js');
    const { createTour, addTourStep, getTour } = await import('../src/tours.js');

    const session = findOrCreateSession('work');
    const tour = createTour(session.id, 'Reading order', AS_TYPED);
    addTourStep(tour.id, 'a.ts', 1, 1, AS_TYPED, AS_TYPED);

    const stored = getTour(tour.id)!;
    expect(stored.body).toBe(AS_TYPED);
    expect(stored.steps[0].body).toBe(AS_TYPED);
    expect(stored.steps[0].annotation).toBe(AS_TYPED);
  });
});
