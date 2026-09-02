import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { ReviewBundle } from '@diffity/api';

let root: string;
let origCwd: string;
let repoDir: string;
let headSha: string;
let repoCount = 0;

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, stdio: 'pipe', encoding: 'utf-8' }).trim();
}

// Sessions in one repository share their open work across commits, so each test gets a
// repository of its own and the tests cannot see each other's threads.
function freshRepo(): string {
  const dir = join(root, `repo-${repoCount++}`);
  execFileSync('git', ['init', '-b', 'main', dir], { stdio: 'pipe' });
  git(dir, ['config', 'user.email', 't@t']);
  git(dir, ['config', 'user.name', 'T']);
  writeFileSync(join(dir, 'a.ts'), 'const a = 1;\nconst b = 2;\nconst c = 3;\n');
  git(dir, ['add', '.']);
  git(dir, ['commit', '-m', 'init']);
  git(dir, ['remote', 'add', 'origin', 'https://github.com/o/r.git']);
  return dir;
}

beforeAll(() => {
  origCwd = process.cwd();
  root = mkdtempSync(join(tmpdir(), 'diffity-bundle-'));
  process.env.DIFFITY_DATA_DIR = join(root, 'notes');
});

beforeEach(() => {
  repoDir = freshRepo();
  headSha = git(repoDir, ['rev-parse', 'HEAD']);
  process.chdir(repoDir);
});

afterAll(() => {
  process.chdir(origCwd);
  delete process.env.DIFFITY_DATA_DIR;
  rmSync(root, { recursive: true, force: true });
});

const agent = { name: 'Agent', type: 'agent' as const };
const you = { name: 'You', type: 'user' as const };

function emptyBundle(): ReviewBundle {
  return {
    formatVersion: 1, headSha, ref: 'work', baseSha: null, repo: null, prNumber: null,
    createdAt: '2026-09-02T12:00:00.000Z', generator: 'test', threads: [], tours: [],
  };
}

async function preparedSession() {
  const { findOrCreateSession } = await import('../src/session.js');
  const { createThread, addReply, updateThreadStatus } = await import('../src/threads.js');
  const { createTour, addTourStep, updateTourStatus } = await import('../src/tours.js');

  const session = findOrCreateSession('work');
  const finding = createThread(session.id, 'a.ts', 'new', 2, 2, 'P2: name this', agent, 'const b = 2;');
  addReply(finding.id, 'Will do', you, 'aside');
  const settled = createThread(session.id, 'a.ts', 'new', 3, 3, 'P3: trailing const', agent);
  updateThreadStatus(settled.id, 'resolved');
  createThread(session.id, '__general__', 'new', 0, 0, 'Two small things', agent);

  const tour = createTour(session.id, 'Reading order', 'Top to bottom');
  addTourStep(tour.id, 'a.ts', 1, 1, 'Where a is born', 'the start');
  addTourStep(tour.id, 'a.ts', 3, 3, 'Where it ends', 'the end');
  updateTourStatus(tour.id, 'ready');
  return session;
}

describe('a review bundle', () => {
  it('carries the session pinned to HEAD, without ids or forge state', async () => {
    const { buildBundle } = await import('../src/bundle.js');
    const session = await preparedSession();

    const bundle = buildBundle(session, { prNumber: 7, generator: 'test' });

    expect(bundle.formatVersion).toBe(1);
    expect(bundle.headSha).toBe(headSha);
    expect(bundle.baseSha).toBe(headSha);
    expect(bundle.ref).toBe('work');
    expect(bundle.repo).toEqual({ owner: 'o', repo: 'r' });
    expect(bundle.prNumber).toBe(7);
    expect(bundle.generator).toBe('test');

    expect(bundle.threads).toHaveLength(3);
    const finding = bundle.threads.find(thread => thread.startLine === 2)!;
    expect(finding.anchorContent).toBe('const b = 2;');
    expect(finding.comments.map(comment => [comment.author.name, comment.kind, comment.body])).toEqual([
      ['Agent', 'review', 'P2: name this'],
      ['You', 'aside', 'Will do'],
    ]);
    expect(bundle.threads.find(thread => thread.startLine === 3)!.status).toBe('resolved');
    expect(bundle.threads.find(thread => thread.filePath === '__general__')!.startLine).toBe(0);
    expect(JSON.stringify(bundle)).not.toMatch(/"id"|sessionId|submitted|githubCommentId|live/);

    expect(bundle.tours).toHaveLength(1);
    expect(bundle.tours[0].status).toBe('ready');
    expect(bundle.tours[0].steps.map(step => step.annotation)).toEqual(['the start', 'the end']);
  });

  it('survives the trip through JSON and the parser unchanged', async () => {
    const { buildBundle } = await import('../src/bundle.js');
    const { parseReviewBundle } = await import('@diffity/api');
    const session = await preparedSession();

    const bundle = buildBundle(session, { prNumber: null, generator: 'test' });
    const parsed = parseReviewBundle(JSON.parse(JSON.stringify(bundle)));

    expect(parsed).toEqual({ ok: true, value: bundle });
  });

  it('imports into a clone at the same commit, and a second import adds nothing', async () => {
    const { buildBundle, importBundle } = await import('../src/bundle.js');
    const { findOrCreateSession } = await import('../src/session.js');
    const { getThreadsForSession } = await import('../src/threads.js');
    const { getToursForSession } = await import('../src/tours.js');
    const bundle = buildBundle(await preparedSession(), { prNumber: null, generator: 'test' });

    const cloneDir = join(root, `clone-${repoCount++}`);
    execFileSync('git', ['clone', '--quiet', repoDir, cloneDir], { stdio: 'pipe' });
    process.chdir(cloneDir);
    const target = findOrCreateSession('work');

    const first = importBundle(target, bundle);
    expect(first).toEqual({ threadsCreated: 3, threadsSkipped: 0, toursCreated: 1, toursSkipped: 0 });

    const threads = getThreadsForSession(target.id);
    const finding = threads.find(thread => thread.startLine === 2)!;
    expect(finding.comments.map(comment => [comment.author.type, comment.kind, comment.body])).toEqual([
      ['agent', 'review', 'P2: name this'],
      ['user', 'aside', 'Will do'],
    ]);
    expect(finding.anchorContent).toBe('const b = 2;');
    expect(threads.find(thread => thread.startLine === 3)!.status).toBe('resolved');
    const tour = getToursForSession(target.id)[0];
    expect(tour.status).toBe('ready');
    expect(tour.steps.map(step => [step.sortOrder, step.body])).toEqual([[1, 'Where a is born'], [2, 'Where it ends']]);

    const second = importBundle(target, bundle);
    expect(second).toEqual({ threadsCreated: 0, threadsSkipped: 3, toursCreated: 0, toursSkipped: 1 });
    expect(getThreadsForSession(target.id)).toHaveLength(3);
    expect(getToursForSession(target.id)).toHaveLength(1);
  });

  it('keeps the comments\' own timestamps, so replies read back in their original order', async () => {
    const { buildBundle, importBundle } = await import('../src/bundle.js');
    const { findOrCreateSession } = await import('../src/session.js');
    const { getThreadsForSession } = await import('../src/threads.js');
    const bundle = buildBundle(await preparedSession(), { prNumber: null, generator: 'test' });
    const exported = bundle.threads.find(thread => thread.startLine === 2)!.comments.map(comment => comment.createdAt);

    const cloneDir = join(root, `clone-${repoCount++}`);
    execFileSync('git', ['clone', '--quiet', repoDir, cloneDir], { stdio: 'pipe' });
    process.chdir(cloneDir);
    const target = findOrCreateSession('work');
    importBundle(target, bundle);

    const imported = getThreadsForSession(target.id).find(thread => thread.startLine === 2)!;
    expect(imported.comments.map(comment => comment.createdAt)).toEqual(exported);
    expect(imported.createdAt).toBe(exported[0]);
  });

  it('does not mistake a reply for an opening comment when deciding what is already there', async () => {
    const { importBundle } = await import('../src/bundle.js');
    const { getThreadsForSession } = await import('../src/threads.js');
    const session = await preparedSession();
    const opensLikeAReply = {
      ...emptyBundle(),
      threads: [{
        filePath: 'a.ts', side: 'new' as const, startLine: 2, endLine: 2, status: 'open' as const, anchorContent: null,
        comments: [{ author: agent, body: 'Will do', kind: 'review' as const, createdAt: '2026-09-02T12:00:00.000Z' }],
      }],
    };

    const outcome = importBundle(session, opensLikeAReply);

    expect(outcome.threadsCreated).toBe(1);
    expect(getThreadsForSession(session.id).filter(thread => thread.startLine === 2)).toHaveLength(2);
  });

  it('imports all or nothing, so a failed import can be retried whole', async () => {
    const { importBundle } = await import('../src/bundle.js');
    const { findOrCreateSession } = await import('../src/session.js');
    const { getThreadsForSession } = await import('../src/threads.js');
    const session = findOrCreateSession('work');
    const sound = {
      filePath: 'a.ts', side: 'new' as const, startLine: 1, endLine: 1, status: 'open' as const, anchorContent: null,
      comments: [{ author: agent, body: 'fine', kind: 'review' as const, createdAt: '2026-09-02T12:00:00.000Z' }],
    };
    // Past the parser on purpose: a body the database refuses, as a stand-in for any mid-import failure.
    const broken = { ...sound, startLine: 3, endLine: 3, comments: [{ ...sound.comments[0], body: null as unknown as string }] };

    expect(() => importBundle(session, { ...emptyBundle(), threads: [sound, broken] })).toThrow();
    expect(getThreadsForSession(session.id)).toHaveLength(0);

    const retried = importBundle(session, { ...emptyBundle(), threads: [sound] });
    expect(retried.threadsCreated).toBe(1);
  });

  it('is not exported once a commit has left the session behind', async () => {
    const { buildBundle, exportMismatch } = await import('../src/bundle.js');
    const session = await preparedSession();
    expect(exportMismatch(session, headSha)).toBeNull();

    writeFileSync(join(repoDir, 'a.ts'), 'const a = 1;\nconst b = 2;\nconst c = 3;\nconst d = 4;\n');
    git(repoDir, ['commit', '-qam', 'more']);
    const movedHead = git(repoDir, ['rev-parse', 'HEAD']);

    expect(exportMismatch(session, movedHead))
      .toBe(`The session was anchored at ${headSha.slice(0, 12)}, but HEAD is ${movedHead.slice(0, 12)}. Open the review once so the findings follow the commit, then export.`);
    expect(buildBundle(session, { prNumber: null, generator: 'test' }).headSha).toBe(headSha);
  });

  it('cautions when the bundle and the session review different scopes', async () => {
    const { buildBundle, scopeWarning } = await import('../src/bundle.js');
    const { findOrCreateSession } = await import('../src/session.js');
    const session = await preparedSession();
    const bundle = buildBundle(session, { prNumber: null, generator: 'test' });

    expect(scopeWarning(bundle, session)).toBeNull();
    expect(scopeWarning(bundle, findOrCreateSession('main')))
      .toBe('The bundle was exported from a session on "work"; this session is on "main". Findings on files outside this diff will not be shown.');
  });

  it('is refused on another commit or another repository', async () => {
    const { buildBundle, importMismatch } = await import('../src/bundle.js');
    const bundle = buildBundle(await preparedSession(), { prNumber: null, generator: 'test' });

    expect(importMismatch(bundle, headSha, { owner: 'o', repo: 'r' })).toBeNull();
    expect(importMismatch(bundle, headSha, { owner: 'O', repo: 'R' })).toBeNull();
    expect(importMismatch(bundle, headSha, null)).toBeNull();

    expect(importMismatch(bundle, 'f'.repeat(40), { owner: 'o', repo: 'r' }))
      .toBe(`The bundle was made at ${headSha.slice(0, 12)}, but HEAD is ffffffffffff.`);
    expect(importMismatch(bundle, headSha, { owner: 'o', repo: 'other' }))
      .toBe('The bundle is for o/r, but this repository is o/other.');
  });
});
