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
  root = mkdtempSync(join(tmpdir(), 'diffity-narrowing-'));
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

// A row can predate validation at the server boundary, or come from a newer schema than this
// build knows. What leaves the storage layer must still be the unions the wire promises.
describe('a row holding values the schema does not know', () => {
  it('comes out narrowed, not casted through', async () => {
    const { findOrCreateSession } = await import('../src/session.js');
    const { createThread, getThread, getThreadsForSession } = await import('../src/threads.js');
    const { getDb } = await import('../src/db.js');

    const session = findOrCreateSession('work');
    const created = createThread(
      session.id, 'a.ts', 'new', 1, 1, 'hello', { name: 'You', type: 'user' },
    );

    getDb().prepare(
      "UPDATE comment_threads SET side = 'sideways', status = 'zapped' WHERE id = ?",
    ).run(created.id);
    getDb().prepare(
      "UPDATE comments SET author_type = 'robot', kind = 'weird' WHERE thread_id = ?",
    ).run(created.id);

    const single = getThread(created.id)!;
    expect(single.side).toBe('new');
    expect(single.status).toBe('open');
    expect(single.comments[0].author.type).toBe('user');
    expect(single.comments[0].kind).toBe('review');

    const listed = getThreadsForSession(session.id).find(thread => thread.id === created.id)!;
    expect(listed.side).toBe('new');
    expect(listed.status).toBe('open');
    expect(listed.comments[0].author.type).toBe('user');
    expect(listed.comments[0].kind).toBe('review');
  });

  it('a tour with an unknown status reads as ready', async () => {
    const { findOrCreateSession } = await import('../src/session.js');
    const { createTour, getTour } = await import('../src/tours.js');
    const { getDb } = await import('../src/db.js');

    const session = findOrCreateSession('work');
    const tour = createTour(session.id, 'Reading order', '');
    getDb().prepare("UPDATE tours SET status = 'paused' WHERE id = ?").run(tour.id);

    expect(getTour(tour.id)!.status).toBe('ready');
  });
});
