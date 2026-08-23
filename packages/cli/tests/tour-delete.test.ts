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
  root = mkdtempSync(join(tmpdir(), 'diffity-tour-delete-'));
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

async function session() {
  const { findOrCreateSession } = await import('../src/session.js');
  return findOrCreateSession('work');
}

describe('correcting a walkthrough', () => {
  it('can be deleted, taking its steps with it', async () => {
    const { createTour, addTourStep, deleteTour, getTour, getToursForSession } = await import(
      '../src/tours.js'
    );
    const s = await session();
    const tour = createTour(s.id, 'wrong order', '');
    addTourStep(tour.id, 'a.ts', 1, 1, 'body', 'annotation');

    deleteTour(tour.id);

    expect(getTour(tour.id)).toBeNull();
    expect(getToursForSession(s.id).some(t => t.id === tour.id)).toBe(false);
  });

  it('leaves another walkthrough alone', async () => {
    const { createTour, deleteTour, getTour } = await import('../src/tours.js');
    const s = await session();
    const doomed = createTour(s.id, 'doomed', '');
    const kept = createTour(s.id, 'kept', '');

    deleteTour(doomed.id);

    expect(getTour(doomed.id)).toBeNull();
    expect(getTour(kept.id)).not.toBeNull();
  });

  it('is silent about an id that is not there', async () => {
    const { deleteTour } = await import('../src/tours.js');

    expect(() => deleteTour('no-such-tour')).not.toThrow();
  });

  it('can replace the newest one in a single step', async () => {
    const { createTour, getToursForSession, deleteToursForSession } = await import('../src/tours.js');
    const s = await session();
    createTour(s.id, 'first attempt', '');
    createTour(s.id, 'second attempt', '');

    deleteToursForSession(s.id);
    const replacement = createTour(s.id, 'the good one', '');

    expect(getToursForSession(s.id).map(t => t.id)).toEqual([replacement.id]);
  });
});
