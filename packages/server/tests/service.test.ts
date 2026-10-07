import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Db } from '../src/db.js';
import { Mirrors } from '../src/git.js';
import { GitHubApi, StoredTokenAccess, type ReviewRequest } from '../src/github.js';
import { Reviews } from '../src/reviews.js';
import {
  ReviewService,
  ServiceError,
  describeSession,
  filterReviewRequests,
  gitHubDetailsFor,
  parseRepoSlug,
} from '../src/service.js';
import { Users } from '../src/users.js';
import { git, makeFixture, memoryDb, removeDir, startFakeGitHub, tempDir, type FakeGitHub, type Fixture } from './helpers.js';
import { randomBytes } from 'node:crypto';

let fixture: Fixture;
let github: FakeGitHub;
let dataDir: string;
let db: Db;
let users: Users;
let reviews: Reviews;
let service: ReviewService;
let alice: string;
let bob: string;
let mallory: string;

beforeAll(async () => {
  fixture = makeFixture();
  github = await startFakeGitHub([
    {
      owner: 'Acme',
      name: 'widgets',
      private: true,
      tokens: ['alice-token', 'bob-token'],
      pulls: { 1: { title: 'Change line ten', baseSha: fixture.mainTip, headSha: fixture.head1 } },
    },
  ]);
  dataDir = tempDir('service');
  db = await memoryDb();
  users = new Users(db, randomBytes(32));
  reviews = new Reviews(db);
  alice = (await users.findOrCreate('alice@example.com')).id;
  bob = (await users.findOrCreate('bob@example.com')).id;
  mallory = (await users.findOrCreate('mallory@example.com')).id;
  await users.setGitHubToken(alice, 'alice-token');
  await users.setGitHubToken(bob, 'bob-token');
  service = new ReviewService(
    reviews,
    new Mirrors(dataDir, fixture.remoteUrl),
    new GitHubApi(github.url),
    new StoredTokenAccess(users, null),
    new URL('http://localhost:5390'),
    users,
  );
});

afterAll(async () => {
  await db.close();
  await github.close();
  removeDir(fixture.root);
  removeDir(dataDir);
});

describe('createSession', () => {
  it('reviews a pull request from its merge base, with the names GitHub uses', async () => {
    const created = await service.createSession(alice, { repo: 'acme/widgets', pr: 1 });
    expect(created.created).toBe(true);
    expect(created.session).toMatchObject({
      owner: 'Acme',
      repo: 'widgets',
      kind: 'pr',
      prNumber: 1,
      baseSha: fixture.base,
      headSha: fixture.head1,
    });
    expect(created.session.prMeta?.title).toBe('Change line ten');
    expect(created.files.map(file => file.newPath).sort()).toEqual(['added.ts', 'src.ts']);
    expect(service.sessionUrl(created.session.id)).toBe(`http://localhost:5390/s/${created.session.id}/`);
    expect(describeSession(created.session)).toBe('#1 Change line ten');
    expect(gitHubDetailsFor(created.session)).toMatchObject({ prNumber: 1, headSha: fixture.head1, prAuthor: 'octocat' });

    const again = await service.createSession(alice, { repo: 'acme/widgets', pr: 1 });
    expect(again.created).toBe(false);
    expect(again.session.id).toBe(created.session.id);
  });

  it('reviews two explicit commits', async () => {
    const created = await service.createSession(alice, { repo: 'acme/widgets', base: fixture.base, head: fixture.head2 });
    expect(created.session.kind).toBe('shas');
    expect(created.session.prNumber).toBeNull();
    expect(gitHubDetailsFor(created.session)).toBeNull();
    expect(describeSession(created.session)).toBe(`${fixture.base.slice(0, 7)}..${fixture.head2.slice(0, 7)}`);
    expect((await service.diffText(created.session)).length).toBeGreaterThan(0);
  });

  it('reviews a patch that was never pushed', async () => {
    const patch = git(fixture.work, ['diff', fixture.base, fixture.head1]) + '\n';
    const created = await service.createSession(alice, { repo: 'acme/widgets', base: fixture.base, patch });
    expect(created.session.kind).toBe('patch');
    expect(created.session.headSha).toBe(git(fixture.work, ['rev-parse', `${fixture.head1}^{tree}`]));
    expect(describeSession(created.session)).toContain('patch (tree');
    await expect(service.createSession(alice, { repo: 'acme/widgets', base: fixture.base, patch: 'garbage\n' }))
      .rejects.toThrow(ServiceError);
  });

  it('keeps each user in their own session of the same change', async () => {
    const mine = await service.createSession(alice, { repo: 'acme/widgets', base: fixture.base, head: fixture.head1 });
    const theirs = await service.createSession(bob, { repo: 'acme/widgets', base: fixture.base, head: fixture.head1 });
    expect(theirs.session.id).not.toBe(mine.session.id);
    expect(await reviews.getSession(bob, mine.session.id)).toBeNull();
    await expect(service.requireSession(bob, mine.session.id)).rejects.toThrow('No session matches');
  });

  it('checks access with the caller’s own token before fetching anything', async () => {
    const before = github.requests.length;
    await expect(service.createSession(mallory, { repo: 'acme/widgets', pr: 1 })).rejects.toThrow('is not readable without GitHub access');
    await users.setGitHubToken(mallory, 'wrong-token');
    await expect(service.createSession(mallory, { repo: 'acme/widgets', pr: 1 })).rejects.toThrow('your GitHub token cannot read it');
    expect(github.requests.slice(before).every(request => request.startsWith('GET /repos/acme/widgets'))).toBe(true);
    expect(github.requests.slice(before).some(request => request.includes('/pulls/'))).toBe(false);
  });

  it.each([
    [{ repo: 'nope' }, 'repo must be'],
    [{ repo: '../x/y' }, 'repo must be'],
    [{ repo: 'acme/widgets' }, 'exactly one of'],
    [{ repo: 'acme/widgets', pr: 1, head: 'a'.repeat(40) }, 'exactly one of'],
    [{ repo: 'acme/widgets', pr: 0 }, 'positive integer'],
    [{ repo: 'acme/widgets', base: 'short', head: 'a'.repeat(40) }, 'base must be'],
    [{ repo: 'acme/widgets', base: 'a'.repeat(40), head: 'short' }, 'head must be'],
    [{ repo: 'acme/widgets', base: 'a'.repeat(40), patch: '  ' }, 'patch is empty'],
    [{ repo: 'acme/widgets', base: 'a'.repeat(40), head: 'b'.repeat(40), patch: 'x' }, 'exactly one of'],
  ])('refuses %j', async (input, message) => {
    await expect(service.createSession(alice, input)).rejects.toThrow(message);
  });

  it('says when the pull request does not exist', async () => {
    await expect(service.createSession(alice, { repo: 'acme/widgets', pr: 99 })).rejects.toThrow('no pull request #99');
  });

  it('parses repository slugs', () => {
    expect(parseRepoSlug('NaturalCycles/diffity.git')).toEqual({ owner: 'NaturalCycles', repo: 'diffity' });
  });
});

describe('carry-forward', () => {
  it('moves open findings to the pull request’s newer head, following renames and moved lines', async () => {
    const first = (await service.createSession(bob, { repo: 'acme/widgets', pr: 1 })).session;
    const onLine10 = await reviews.createThread({
      userId: bob, sessionId: first.id, filePath: 'src.ts', side: 'new', startLine: 10, endLine: 10,
      body: 'Why this change?', author: { name: 'Agent', type: 'agent' }, anchorContent: 'line 10 changed by the feature',
    });
    const onRenamed = await reviews.createThread({
      userId: bob, sessionId: first.id, filePath: 'old-name.ts', side: 'new', startLine: 1, endLine: 1,
      body: 'Name this better', author: { name: 'Agent', type: 'agent' }, anchorContent: 'export const moved = true;',
    });
    const done = await reviews.createThread({
      userId: bob, sessionId: first.id, filePath: 'added.ts', side: 'new', startLine: 1, endLine: 1,
      body: 'Resolved already', author: { name: 'Agent', type: 'agent' },
    });
    await reviews.updateThreadStatus(bob, done.id, 'resolved');
    const tour = await reviews.createTour(bob, first.id, 'Reading order', '');

    fixture.pushPull(fixture.head2);
    try {
      const second = await service.createSession(bob, { repo: 'acme/widgets', pr: 1 });
      expect(second.created).toBe(true);
      expect(second.session.headSha).toBe(fixture.head2);
      expect(second.carried).toBe(2);

      const carried = await reviews.threadsForSession(bob, second.session.id);
      expect(carried.map(t => t.id).sort()).toEqual([onLine10.id, onRenamed.id].sort());
      expect(carried.find(t => t.id === onLine10.id)).toMatchObject({ startLine: 13, endLine: 13 });
      expect(carried.find(t => t.id === onRenamed.id)).toMatchObject({ filePath: 'new-name.ts' });
      expect((await reviews.threadsForSession(bob, first.id)).map(t => t.id)).toEqual([done.id]);
      expect((await reviews.getTour(bob, tour.id))?.sessionId).toBe(second.session.id);

      // Alice's session of the same pull request is hers alone and is not touched.
      const alices = (await reviews.listSessions(alice)).filter(s => s.prNumber === 1);
      expect(alices.every(s => s.headSha === fixture.head1)).toBe(true);
    } finally {
      fixture.pushPull(fixture.head1);
    }
  });
});

describe('reading a session', () => {
  it('answers the parsed diff with base line counts, and what hiding whitespace suppressed', async () => {
    const { session } = await service.createSession(alice, { repo: 'acme/widgets', base: fixture.base, head: fixture.head1 });
    const diff = await service.parsedDiff(session);
    const src = diff.files.find(file => file.newPath === 'src.ts')!;
    expect(src.oldFileLineCount).toBe(30);
    expect(diff.suppressed).toBeNull();
    const hidden = await service.parsedDiff(session, { ignoreWhitespace: true });
    expect(hidden.suppressed).toEqual({ files: 0, lines: 0 });
    expect(await service.diffText(session, { path: 'added.ts' })).toContain('+++ b/added.ts');
    expect(await service.diffText(session, { path: 'added.ts' })).not.toContain('src.ts');
    await expect(service.diffText(session, { path: '../x' })).rejects.toThrow('Not a repository path');
  });

  it('reads the project standards at the head, and the defaults without them', async () => {
    const { session } = await service.createSession(alice, { repo: 'acme/widgets', base: fixture.base, head: fixture.head1 });
    expect(await service.standards(session)).toEqual({
      severities: ['blocker', 'nit'],
      standards: { path: 'STANDARDS.md', content: 'Every P1 must have a test.\n' },
    });
    expect(await service.readFile(session, 'old', 'added.ts')).toBeNull();
    expect(await service.readFile(session, 'new', '/etc/passwd')).toBeNull();
  });

  it('refuses a comment on a file outside the diff, naming the files it has', async () => {
    const { session } = await service.createSession(alice, { repo: 'acme/widgets', base: fixture.base, head: fixture.head1 });
    await expect(service.assertInDiff(session, 'src.ts', 'new')).resolves.toBeUndefined();
    await expect(service.assertInDiff(session, 'README.md', 'new')).rejects.toThrow(/not on the new side[\s\S]*src\.ts/);
  });
});

describe('review requests', () => {
  const request = (title: string, draft = false): ReviewRequest => ({
    owner: 'acme', repo: 'widgets', number: 1, title, author: 'octocat', draft, updatedAt: '2026-10-01T10:00:00Z', url: 'u',
  });

  it('leaves out drafts unless asked, and titles containing a pattern, ignoring case', () => {
    const all = [request('Bump lodash'), request('Fix the login'), request('WIP: sketch', true), request('Chore: deps')];
    expect(filterReviewRequests(all, { skipTitles: [], includeDrafts: false }).map(r => r.title))
      .toEqual(['Bump lodash', 'Fix the login', 'Chore: deps']);
    expect(filterReviewRequests(all, { skipTitles: ['bump', ' CHORE ', '  '], includeDrafts: true }).map(r => r.title))
      .toEqual(['Fix the login', 'WIP: sketch']);
  });

  it('keeps each user’s filters, with defaults until they are set', async () => {
    const carol = (await users.findOrCreate('carol@example.com')).id;
    expect(await users.settings(carol)).toEqual({ skipTitles: [], includeDrafts: false });
    await users.setSettings(carol, { skipTitles: ['Bump', 'release'], includeDrafts: true });
    expect(await users.settings(carol)).toEqual({ skipTitles: ['Bump', 'release'], includeDrafts: true });
    expect(await users.settings(alice)).toEqual({ skipTitles: [], includeDrafts: false });
  });

  it('asks GitHub’s search for open pull requests requesting the token’s review, and maps what it finds', async () => {
    github.reviewRequests['search-token'] = [
      { owner: 'acme', repo: 'widgets', number: 7, title: 'Seven', author: 'dave', draft: true, updatedAt: '2026-10-02T08:30:00Z' },
    ];
    const api = new GitHubApi(github.url);
    expect(await api.reviewRequests('search-token')).toEqual([{
      owner: 'acme', repo: 'widgets', number: 7, title: 'Seven', author: 'dave', draft: true,
      updatedAt: '2026-10-02T08:30:00Z', url: 'https://github.com/acme/widgets/pull/7',
    }]);
    expect(github.searches.at(-1)).toBe('is:pr is:open archived:false review-requested:@me');

    github.failSearchWith = 422;
    try {
      expect(await api.reviewRequests('search-token')).toEqual([]);
      github.failSearchWith = 500;
      await expect(api.reviewRequests('search-token')).rejects.toThrow('GitHub answered 500');
    } finally {
      github.failSearchWith = null;
    }
  });

  it('lists them for the user with their newest session on each, filtered, and asks GitHub once a minute', async () => {
    github.reviewRequests['bob-token'] = [
      { owner: 'acme', repo: 'widgets', number: 1, title: 'Change line ten', author: 'octocat', updatedAt: '2026-10-03T09:00:00Z' },
      { owner: 'acme', repo: 'widgets', number: 2, title: 'Bump lodash', author: 'dependabot', updatedAt: '2026-10-02T09:00:00Z' },
      { owner: 'acme', repo: 'widgets', number: 3, title: 'Sketch', author: 'octocat', draft: true, updatedAt: '2026-10-01T09:00:00Z' },
    ];
    await service.createSession(bob, { repo: 'acme/widgets', pr: 1 });
    const newest = (await reviews.listSessions(bob)).find(s => s.prNumber === 1)!;
    const now = Date.now();
    const searches = github.searches.length;

    const found = await service.reviewRequests(bob, now);
    expect(found?.hidden).toBe(1);
    expect(found?.requests.map(r => [r.number, r.session?.id ?? null])).toEqual([[1, newest.id], [2, null]]);
    expect(found?.requests[0].session).toEqual({ id: newest.id, headSha: newest.headSha, createdAt: newest.createdAt });

    await users.setSettings(bob, { skipTitles: ['bump'], includeDrafts: true });
    expect((await service.reviewRequests(bob, now + 30_000))?.requests.map(r => r.number)).toEqual([1, 3]);
    expect(github.searches.length).toBe(searches + 1);
    await service.reviewRequests(bob, now + 61_000);
    expect(github.searches.length).toBe(searches + 2);
    await users.setSettings(bob, { skipTitles: [], includeDrafts: false });
  });

  it('never links another user’s session, and answers null without GitHub access', async () => {
    github.reviewRequests['alice-token'] = [
      { owner: 'acme', repo: 'widgets', number: 1, title: 'Change line ten', author: 'octocat', updatedAt: '2026-10-03T09:00:00Z' },
    ];
    const dora = (await users.findOrCreate('dora@example.com')).id;
    expect(await service.reviewRequests(dora)).toBeNull();
    const alices = (await reviews.listSessions(alice)).filter(s => s.prNumber === 1).map(s => s.id);
    const found = await service.reviewRequests(alice);
    expect(alices).toContain(found?.requests[0].session?.id);
  });
});
