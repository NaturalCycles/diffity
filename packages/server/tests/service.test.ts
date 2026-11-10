import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
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
let pulls: Record<number, { title: string; baseSha: string; headSha: string; closed?: boolean }>;

beforeAll(async () => {
  fixture = makeFixture();
  pulls = { 1: { title: 'Change line ten', baseSha: fixture.mainTip, headSha: fixture.head1 } };
  github = await startFakeGitHub([
    {
      owner: 'Acme',
      name: 'widgets',
      private: true,
      tokens: ['alice-token', 'bob-token'],
      pulls,
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

describe('on a new instance, without the mirror', () => {
  const restarted = () => {
    removeDir(new Mirrors(dataDir, fixture.remoteUrl).pathFor('acme', 'widgets'));
    return new ReviewService(
      reviews,
      new Mirrors(dataDir, fixture.remoteUrl),
      new GitHubApi(github.url),
      new StoredTokenAccess(users, null),
      new URL('http://localhost:5390'),
      users,
    );
  };

  it('still reads a pull request session', async () => {
    const { session } = await service.createSession(alice, { repo: 'acme/widgets', pr: 1 });
    const fresh = restarted();
    expect((await fresh.changedFiles(session)).map(file => file.newPath).sort()).toEqual(['added.ts', 'src.ts']);
    expect(await fresh.diffText(session)).toContain('+line 10 changed by the feature');
  });

  it('says a patch session has to be made again', async () => {
    const patch = 'diff --git a/patched.ts b/patched.ts\nnew file mode 100644\n--- /dev/null\n+++ b/patched.ts\n@@ -0,0 +1 @@\n+export const patched = true;\n';
    const { session } = await service.createSession(alice, { repo: 'acme/widgets', base: fixture.base, patch });
    await expect(restarted().diffText(session)).rejects.toThrow('This session was made from a patch and its tree did not outlive a server restart; create it again');
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
      github.failSearchWith = 403;
      await expect(api.reviewRequests('search-token')).rejects.toThrow('GitHub answered 403');
      github.failSearchWith = 500;
      await expect(api.reviewRequests('search-token')).rejects.toThrow('GitHub answered 500');
    } finally {
      github.failSearchWith = null;
    }
  });

  it('lists the token’s own pull requests, with threads and requested reviewers where GraphQL shows them', async () => {
    github.ownPulls['own-search-token'] = [
      { owner: 'acme', repo: 'widgets', number: 8, title: 'Eight', author: 'erin', draft: true, updatedAt: '2026-10-02T08:30:00Z',
        threads: [false, true], threadCount: 120, reviewers: ['kirill', { team: 'platform' }], reviewerCount: 2, reviewDecision: 'REVIEW_REQUIRED' },
      { owner: 'other', repo: 'elsewhere', number: 9, title: 'Nine', author: 'erin', updatedAt: '2026-10-02T08:00:00Z', forbidden: true },
    ];
    const api = new GitHubApi(github.url);
    expect(await api.ownPulls('own-search-token')).toEqual([{
      owner: 'acme', repo: 'widgets', number: 8, title: 'Eight', author: 'erin', draft: true,
      updatedAt: '2026-10-02T08:30:00Z', url: 'https://github.com/acme/widgets/pull/8',
      openThreads: 1, moreThreads: true, requestedReviewers: ['kirill', 'platform'], requestedReviewerCount: 2,
      reviewDecision: 'REVIEW_REQUIRED',
    }, {
      owner: 'other', repo: 'elsewhere', number: 9, title: 'Nine', author: 'erin', draft: false,
      updatedAt: '2026-10-02T08:00:00Z', url: 'https://github.com/other/elsewhere/pull/9',
    }]);
    expect(github.searches.slice(-2)).toEqual([
      'is:pr is:open archived:false author:@me',
      'is:pr is:open archived:false author:@me sort:updated-desc',
    ]);

    try {
      github.failSearchWith = 403;
      await expect(api.ownPulls('own-search-token')).rejects.toThrow('GitHub answered 403');
      github.failSearchWith = 422;
      expect(await api.ownPulls('own-search-token')).toEqual([]);
      github.failSearchWith = 500;
      await expect(api.ownPulls('own-search-token')).rejects.toThrow('GitHub answered 500');
      github.failSearchWith = null;
      github.graphqlSearchErrors = ['API rate limit exceeded'];
      expect((await api.ownPulls('own-search-token')).map(pull => pull.requestedReviewers)).toEqual([undefined, undefined]);
    } finally {
      github.failSearchWith = null;
      github.graphqlSearchErrors = null;
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

    const found = await service.reviewRequests(bob, { now });
    expect(found?.hidden).toBe(1);
    expect(found?.requests.map(r => [r.number, r.session?.id ?? null])).toEqual([[1, newest.id], [2, null]]);
    expect(found?.requests[0].session).toEqual({ id: newest.id, headSha: newest.headSha, createdAt: newest.createdAt });

    await users.setSettings(bob, { skipTitles: ['bump'], includeDrafts: true });
    expect((await service.reviewRequests(bob, { now: now + 30_000 }))?.requests.map(r => r.number)).toEqual([1, 3]);
    expect(github.searches.length).toBe(searches + 1);
    await service.reviewRequests(bob, { now: now + 61_000 });
    expect(github.searches.length).toBe(searches + 2);
    await users.setSettings(bob, { skipTitles: [], includeDrafts: false });
  });

  it('says when GitHub was asked, and asks again when fresh, replacing the cached answer', async () => {
    github.reviewRequests['bob-token'] = [
      { owner: 'acme', repo: 'widgets', number: 1, title: 'Change line ten', author: 'octocat', updatedAt: '2026-10-03T09:00:00Z' },
    ];
    github.ownPulls['bob-token'] = [
      { owner: 'acme', repo: 'widgets', number: 4, title: 'Mine', author: 'bob', updatedAt: '2026-10-03T09:00:00Z' },
    ];
    const now = Date.now() + 200_000;
    const searches = github.searches.length;

    expect((await service.reviewRequests(bob, { now }))?.fetchedAt).toBe(now);
    expect((await service.reviewRequests(bob, { now: now + 10_000 }))?.fetchedAt).toBe(now);
    expect(github.searches.length).toBe(searches + 1);

    expect((await service.reviewRequests(bob, { now: now + 5_000, fresh: true }))?.fetchedAt).toBe(now);
    expect(github.searches.length).toBe(searches + 1);
    expect((await service.reviewRequests(bob, { now: now + 20_000, fresh: true }))?.fetchedAt).toBe(now + 20_000);
    expect(github.searches.length).toBe(searches + 2);
    expect((await service.reviewRequests(bob, { now: now + 30_000 }))?.fetchedAt).toBe(now + 20_000);
    expect(github.searches.length).toBe(searches + 2);

    const own = await service.ownPulls(bob, { now: now + 30_000 });
    expect(own?.fetchedAt).toBe(now + 30_000);
    expect(own?.requests.map(r => r.number)).toEqual([4]);
    expect((await service.ownPulls(bob, { now: now + 40_000, fresh: true }))?.fetchedAt).toBe(now + 40_000);
    expect(github.searches.length).toBe(searches + 6);
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

describe('following a pull request’s head', () => {
  let erin: string;
  const pullLookups = () => github.requests.filter(request => request.toLowerCase() === 'get /repos/acme/widgets/pulls/1').length;
  const moveTo = (sha: string) => {
    pulls[1].headSha = sha;
    fixture.pushPull(sha);
  };

  beforeAll(async () => {
    erin = (await users.findOrCreate('erin@example.com')).id;
    await users.setGitHubToken(erin, 'bob-token');
  });

  it('keeps a session at the current head, and a session of no pull request', async () => {
    const session = (await service.createSession(erin, { repo: 'acme/widgets', pr: 1 })).session;
    expect(await service.advanceSession(session)).toEqual(session);
    expect(await service.movedOn(session)).toBeNull();
    const commits = (await service.createSession(erin, { repo: 'acme/widgets', base: fixture.mainTip, head: fixture.head2 })).session;
    const lookups = pullLookups();
    expect(await service.advanceSession(commits)).toBe(commits);
    expect(await service.movedOn(commits)).toBeNull();
    expect(pullLookups()).toBe(lookups);
  });

  it('moves to a session at the new head with the open findings, made once', async () => {
    const session = (await service.createSession(erin, { repo: 'acme/widgets', pr: 1 })).session;
    const open = await reviews.createThread({
      userId: erin, sessionId: session.id, filePath: 'src.ts', side: 'new', startLine: 10, endLine: 10,
      body: 'Why this change?', author: { name: 'Agent', type: 'agent' }, anchorContent: 'line 10 changed by the feature',
    });
    moveTo(fixture.head2);
    try {
      const advanced = await service.advanceSession(session);
      expect(advanced.id).not.toBe(session.id);
      expect(advanced.headSha).toBe(fixture.head2);
      expect((await reviews.threadsForSession(erin, advanced.id)).map(t => [t.id, t.startLine])).toEqual([[open.id, 13]]);
      expect(await service.movedOn(session)).toEqual({ headSha: fixture.head2, sessionId: advanced.id });
      expect((await service.advanceSession(session)).id).toBe(advanced.id);
      expect(await service.movedOn(advanced)).toBeNull();
    } finally {
      moveTo(fixture.head1);
    }
  });

  it('leaves a closed pull request where it is', async () => {
    const session = (await service.createSession(erin, { repo: 'acme/widgets', pr: 1 })).session;
    pulls[1].closed = true;
    pulls[1].headSha = fixture.head2;
    try {
      expect(await service.advanceSession(session)).toBe(session);
      expect(await service.movedOn(session)).toBeNull();
    } finally {
      pulls[1].closed = false;
      pulls[1].headSha = fixture.head1;
    }
  });

  it('advances onto a session that already exists at the head, carrying only the findings left behind', async () => {
    const gina = (await users.findOrCreate('gina@example.com')).id;
    await users.setGitHubToken(gina, 'bob-token');
    const old = (await service.createSession(gina, { repo: 'acme/widgets', pr: 1 })).session;
    const finding = (body: string, sessionId: string) => reviews.createThread({
      userId: gina, sessionId, filePath: 'src.ts', side: 'new', startLine: 10, endLine: 10,
      body, author: { name: 'Agent', type: 'agent' }, anchorContent: 'line 10 changed by the feature',
    });
    moveTo(fixture.head2);
    try {
      const current = (await service.createSession(gina, { repo: 'acme/widgets', pr: 1 })).session;
      const own = await finding('Left on the new head', current.id);
      const later = await finding('Written in a tab still on the old head', old.id);

      const advanced = await service.advanceSession(old);
      expect(advanced.id).toBe(current.id);
      const lines = new Map((await reviews.threadsForSession(gina, current.id)).map(t => [t.id, t.startLine]));
      expect(lines.get(later.id)).toBe(13);
      expect(lines.get(own.id)).toBe(10);
      expect(await reviews.threadsForSession(gina, old.id, 'open')).toEqual([]);
    } finally {
      moveTo(fixture.head1);
    }
  });

  it('only makes the head’s session when asked not to carry, leaving the findings where they are', async () => {
    const jan = (await users.findOrCreate('jan@example.com')).id;
    await users.setGitHubToken(jan, 'bob-token');
    const old = (await service.createSession(jan, { repo: 'acme/widgets', pr: 1 })).session;
    const kept = await reviews.createThread({
      userId: jan, sessionId: old.id, filePath: 'src.ts', side: 'new', startLine: 10, endLine: 10,
      body: 'Still being replied to', author: { name: 'Agent', type: 'agent' }, anchorContent: 'line 10 changed by the feature',
    });
    moveTo(fixture.head2);
    try {
      const prepared = await service.advanceSession(old, { carry: false });
      expect(prepared.id).not.toBe(old.id);
      expect(await reviews.threadsForSession(jan, prepared.id)).toEqual([]);
      expect((await reviews.threadsForSession(jan, old.id, 'open')).map(t => t.id)).toEqual([kept.id]);

      expect((await service.advanceSession(old)).id).toBe(prepared.id);
      expect((await reviews.threadsForSession(jan, prepared.id)).map(t => [t.id, t.startLine])).toEqual([[kept.id, 13]]);
    } finally {
      moveTo(fixture.head1);
    }
  });

  it('carries the findings left behind when making the head’s session finds it already there', async () => {
    const hal = (await users.findOrCreate('hal@example.com')).id;
    await users.setGitHubToken(hal, 'bob-token');
    const first = (await service.createSession(hal, { repo: 'acme/widgets', pr: 1 })).session;
    moveTo(fixture.head2);
    try {
      const second = (await service.createSession(hal, { repo: 'acme/widgets', pr: 1 })).session;
      const later = await reviews.createThread({
        userId: hal, sessionId: second.id, filePath: 'src.ts', side: 'new', startLine: 13, endLine: 13,
        body: 'On the second head', author: { name: 'Agent', type: 'agent' }, anchorContent: 'line 10 changed by the feature',
      });
      moveTo(fixture.head1);
      const lookup = vi.spyOn(reviews, 'prSessionAt').mockResolvedValueOnce(null);
      const back = await service.advanceSession(second);
      lookup.mockRestore();
      expect(back.id).toBe(first.id);
      expect((await reviews.threadsForSession(hal, first.id)).map(t => [t.id, t.startLine])).toEqual([[later.id, 10]]);
    } finally {
      moveTo(fixture.head1);
    }
  });

  it('shows the review requests’ current head without making or moving anything, asking GitHub only about updated pull requests, once a minute', async () => {
    const dave = (await users.findOrCreate('dave@example.com')).id;
    await users.setGitHubToken(dave, 'bob-token');
    const request = { owner: 'acme', repo: 'widgets', number: 1, title: 'Change line ten', author: 'octocat', updatedAt: '2026-10-03T09:00:00Z' };
    github.reviewRequests['bob-token'] = [request];
    const session = (await service.createSession(dave, { repo: 'acme/widgets', pr: 1 })).session;
    const open = await reviews.createThread({
      userId: dave, sessionId: session.id, filePath: 'src.ts', side: 'new', startLine: 10, endLine: 10,
      body: 'Still open', author: { name: 'Agent', type: 'agent' },
    });

    const lookups = pullLookups();
    const unchanged = (await service.reviewRequests(dave))!.requests[0];
    expect(unchanged.session?.id).toBe(session.id);
    expect(unchanged.movedTo).toBeNull();
    expect(pullLookups()).toBe(lookups);

    github.reviewRequests['bob-token'] = [{ ...request, updatedAt: '2999-01-01T00:00:00Z' }];
    moveTo(fixture.head2);
    try {
      const now = Date.now() + 120_000;
      const sessionsBefore = (await reviews.listSessions(dave)).length;
      const row = (await service.reviewRequests(dave, { now }))!.requests[0];
      expect(row.session?.id).toBe(session.id);
      expect(row.movedTo).toBe(fixture.head2);
      expect((await reviews.listSessions(dave)).length).toBe(sessionsBefore);
      expect((await reviews.getThread(dave, open.id))?.sessionId).toBe(session.id);
      const afterMove = pullLookups();
      expect(afterMove).toBeGreaterThan(lookups);
      expect((await service.reviewRequests(dave, { now }))!.requests[0].movedTo).toBe(fixture.head2);
      expect(pullLookups()).toBe(afterMove);
    } finally {
      moveTo(fixture.head1);
      github.reviewRequests['bob-token'] = [];
    }
  });

  it('links the session at the current head where the user already has one', async () => {
    const ivy = (await users.findOrCreate('ivy@example.com')).id;
    await users.setGitHubToken(ivy, 'bob-token');
    const atHead1 = (await service.createSession(ivy, { repo: 'acme/widgets', pr: 1 })).session;
    moveTo(fixture.head2);
    await service.createSession(ivy, { repo: 'acme/widgets', pr: 1 });
    moveTo(fixture.head1);
    github.reviewRequests['bob-token'] = [
      { owner: 'acme', repo: 'widgets', number: 1, title: 'Change line ten', author: 'octocat', updatedAt: '2999-01-01T00:00:00Z' },
    ];
    try {
      const row = (await service.reviewRequests(ivy, { now: Date.now() + 360_000 }))!.requests[0];
      expect(row.session).toMatchObject({ id: atHead1.id, headSha: fixture.head1 });
      expect(row.movedTo).toBeNull();
    } finally {
      github.reviewRequests['bob-token'] = [];
    }
  });

  it('keeps a row as it is when its head cannot be looked up', async () => {
    const frank = (await users.findOrCreate('frank@example.com')).id;
    await users.setGitHubToken(frank, 'bob-token');
    const session = (await service.createSession(frank, { repo: 'acme/widgets', pr: 1 })).session;
    github.reviewRequests['bob-token'] = [
      { owner: 'acme', repo: 'widgets', number: 1, title: 'Change line ten', author: 'octocat', updatedAt: '2999-01-01T00:00:00Z' },
    ];
    pulls[1].headSha = fixture.head2;
    const failing = vi.spyOn(reviews, 'prSessionAt').mockRejectedValueOnce(new Error('database unavailable'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const rows = (await service.reviewRequests(frank, { now: Date.now() + 240_000 }))!.requests;
      expect(rows[0].session?.id).toBe(session.id);
      expect(rows[0].movedTo).toBeNull();
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('database unavailable'));
    } finally {
      failing.mockRestore();
      warn.mockRestore();
      pulls[1].headSha = fixture.head1;
      github.reviewRequests['bob-token'] = [];
    }
  });
});
