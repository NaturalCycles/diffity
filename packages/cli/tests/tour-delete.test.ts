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

  it('can replace its own half-written attempts in a single step', async () => {
    const { createTour, getToursForSession, deleteToursForSession } = await import('../src/tours.js');
    const s = await session();
    createTour(s.id, 'first attempt', '');
    createTour(s.id, 'second attempt', '');

    // A walkthrough starts out building, so clearing your own needs saying so.
    deleteToursForSession(s.id, { keepBuilding: false });
    const replacement = createTour(s.id, 'the good one', '');

    expect(getToursForSession(s.id).map(t => t.id)).toEqual([replacement.id]);
  });
});

describe('a walkthrough still being written', () => {
  it('survives a bulk delete, because something is mid-flight', async () => {
    const { createTour, updateTourStatus, deleteToursForSession, getTour } = await import(
      '../src/tours.js'
    );
    const s = await session();
    const finished = createTour(s.id, 'finished', '');
    updateTourStatus(finished.id, 'ready');
    const building = createTour(s.id, 'still writing', '');

    deleteToursForSession(s.id);

    expect(getTour(finished.id)).toBeNull();
    expect(getTour(building.id)).not.toBeNull();
  });

  it('can still be deleted on purpose, by id', async () => {
    const { createTour, deleteTour, getTour } = await import('../src/tours.js');
    const s = await session();
    const building = createTour(s.id, 'abandoned halfway', '');

    deleteTour(building.id);

    expect(getTour(building.id)).toBeNull();
  });
});

async function runAgent(args: string[]): Promise<number> {
  const { Command } = await import('commander');
  const { registerAgentCommands } = await import('../src/agent.js');
  const program = new Command();
  program.exitOverride();
  registerAgentCommands(program);
  process.exitCode = 0;
  await program.parseAsync(['node', 'diffity', 'agent', ...args]);
  const code = process.exitCode ?? 0;
  process.exitCode = 0;
  return code;
}

describe('the command that removes walkthroughs', () => {
  // "Fix the walkthrough" used to be enough to wipe one a human had recorded, because the bulk
  // form was the one you got by leaving the id off.
  it('refuses to do anything without an id', async () => {
    const { createTour, getToursForSession } = await import('../src/tours.js');
    const s = await session();
    createTour(s.id, 'someone else work', '');

    const code = await runAgent(['tour-delete']);

    expect(code).toBe(1);
    expect(getToursForSession(s.id).length).toBeGreaterThan(0);
  });

  it('sweeps the session when asked to', async () => {
    const { createTour, updateTourStatus, getToursForSession } = await import('../src/tours.js');
    const s = await session();
    const finished = createTour(s.id, 'finished', '');
    updateTourStatus(finished.id, 'ready');

    await runAgent(['tour-delete', '--all']);

    expect(getToursForSession(s.id).some(t => t.id === finished.id)).toBe(false);
  });

  it('leaves an in-flight walkthrough for --all alone', async () => {
    const { createTour, getTour } = await import('../src/tours.js');
    const s = await session();
    const building = createTour(s.id, 'mid-flight', '');

    await runAgent(['tour-delete', '--all']);

    expect(getTour(building.id)).not.toBeNull();
  });

  it('takes the in-flight one too when told', async () => {
    const { createTour, getTour } = await import('../src/tours.js');
    const s = await session();
    const building = createTour(s.id, 'mid-flight', '');

    await runAgent(['tour-delete', '--all', '--include-building']);

    expect(getTour(building.id)).toBeNull();
  });

  it('removes just the one it is given', async () => {
    const { createTour, getTour } = await import('../src/tours.js');
    const s = await session();
    const doomed = createTour(s.id, 'doomed', '');
    const kept = createTour(s.id, 'kept', '');

    await runAgent(['tour-delete', doomed.id]);

    expect(getTour(doomed.id)).toBeNull();
    expect(getTour(kept.id)).not.toBeNull();
  });
});
