import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { GitHubDetails, PullCommentsResult, ReviewResult } from '@diffity/api';
import type { ReviewSessionRecord } from '../src/reviews.js';
import {
  login,
  makeFixture,
  removeDir,
  startFakeGitHub,
  startTestServer,
  tempDir,
  type FakeGitHub,
  type Fixture,
  type TestServer,
} from './helpers.js';

let fixture: Fixture;
let github: FakeGitHub;
let dataDir: string;
let server: TestServer;
let aliceCookie: string;
let bobCookie: string;
let aliceId: string;
let prSession: ReviewSessionRecord;
let shasSession: ReviewSessionRecord;

let repoPulls: Record<number, { title: string; baseSha: string; headSha: string; author: string }>;

async function post(sessionId: string, path: string, json: unknown, cookie = aliceCookie): Promise<{ status: number; body: any }> {
  const res = await fetch(`${server.base}/s/${sessionId}/api${path}`, {
    method: 'POST',
    headers: { cookie, 'Content-Type': 'application/json', 'Sec-Fetch-Site': 'same-origin' },
    body: JSON.stringify(json),
  });
  return { status: res.status, body: await res.json() };
}

beforeAll(async () => {
  fixture = makeFixture();
  repoPulls = { 1: { title: 'Change line ten', baseSha: fixture.mainTip, headSha: fixture.head1, author: 'alice-gh' } };
  github = await startFakeGitHub([{ owner: 'acme', name: 'widgets', private: true, tokens: ['alice-token'], pulls: repoPulls }]);
  github.logins['alice-token'] = 'alice-gh';
  dataDir = tempDir('posting');
  server = await startTestServer(dataDir, github.url, { remoteUrl: fixture.remoteUrl });
  aliceCookie = await login(server.base, 'alice@example.com');
  bobCookie = await login(server.base, 'bob@example.com');
  aliceId = (await server.users.findOrCreate('alice@example.com')).id;
  await server.users.setGitHubToken(aliceId, 'alice-token');
  prSession = (await server.service.createSession(aliceId, { repo: 'acme/widgets', pr: 1 })).session;
  shasSession = (await server.service.createSession(aliceId, { repo: 'acme/widgets', base: fixture.base, head: fixture.head2 })).session;
});

afterAll(async () => {
  await server.close();
  await github.close();
  removeDir(fixture.root);
  removeDir(dataDir);
});

async function finding(line: number, body: string) {
  return server.service.reviews.createThread({
    userId: aliceId, sessionId: prSession.id, filePath: 'src.ts', side: 'new', startLine: line, endLine: line,
    body, author: { name: 'Agent', type: 'agent' },
  });
}

describe('posting a review', () => {
  it('sends the findings GitHub can take in one review against the session head, and records them as sent', async () => {
    const onTen = await finding(10, 'P1: line ten changed without a test');
    const res = await post(prSession.id, '/github/create-review', {
      event: 'COMMENT',
      body: 'One finding.',
      comments: [
        { threadId: onTen.id, filePath: 'src.ts', side: 'RIGHT', endLine: 10, body: onTen.comments[0].body },
        { filePath: 'README.md', side: 'RIGHT', endLine: 1, body: 'Not in the diff' },
        { filePath: 'src.ts', side: 'RIGHT', endLine: 30, body: 'Not a diff line' },
      ],
    });
    expect(res.status).toBe(200);
    const result = res.body as ReviewResult;
    expect(result).toMatchObject({ submitted: 1, submittedThreadIds: [onTen.id], skipped: 0, failed: 2, commitSha: fixture.head1 });
    expect(result.errors.join('\n')).toMatch(/README\.md — not in the pull request's diff[\s\S]*src\.ts:30/);
    expect(result.reviewUrl).toContain('#pullrequestreview-');
    expect(github.postedReviews.at(-1)).toEqual({
      commit_id: fixture.head1,
      event: 'COMMENT',
      body: 'One finding.',
      comments: [{ path: 'src.ts', side: 'RIGHT', line: 10, body: onTen.comments[0].body }],
    });
    const sent = (await server.service.reviews.getThread(aliceId, onTen.id))!;
    expect(sent).toMatchObject({ submittedReviewUrl: result.reviewUrl, submittedHeadSha: fixture.head1, submittedBody: onTen.comments[0].body });
    expect(sent.githubCommentId).toBe(result.commentIds[0].githubCommentId);
  });

  it('never sends a finding twice, and a comment review with nothing new posts nothing', async () => {
    const [sent] = await server.service.reviews.threadsForSession(aliceId, prSession.id);
    const before = github.postedReviews.length;
    const res = await post(prSession.id, '/github/create-review', {
      event: 'COMMENT',
      comments: [{ threadId: sent.id, filePath: 'src.ts', side: 'RIGHT', endLine: 10, body: 'Reworded since' }],
    });
    expect(res.body).toMatchObject({ submitted: 0, skipped: 1, reviewUrl: null });
    expect(github.postedReviews.length).toBe(before);
  });

  it('reports GitHub refusing the review without marking anything sent', async () => {
    const other = await finding(11, 'P2: another');
    github.failReviewWith = 422;
    try {
      const res = await post(prSession.id, '/github/create-review', {
        event: 'REQUEST_CHANGES',
        comments: [{ threadId: other.id, filePath: 'src.ts', side: 'RIGHT', endLine: 11, body: 'P2: another' }],
      });
      expect(res.body).toMatchObject({ submitted: 0, failed: 1, reviewUrl: null });
      expect(res.body.errors[0]).toContain('Line could not be resolved');
      expect((await server.service.reviews.getThread(aliceId, other.id))!.submittedAt).toBeNull();
    } finally {
      github.failReviewWith = null;
      await server.service.reviews.deleteThread(aliceId, other.id);
    }
  });

  it('refuses a session that is no pull request, a user without GitHub, an empty comment, and a moved head', async () => {
    expect((await post(shasSession.id, '/github/create-review', { event: 'APPROVE' })).status).toBe(400);
    expect((await post(prSession.id, '/github/create-review', { event: 'COMMENT', body: ' ' })).status).toBe(400);
    expect((await post(prSession.id, '/github/create-review', { event: 'LGTM' })).status).toBe(400);

    const bobId = (await server.users.findOrCreate('bob@example.com')).id;
    const bobs = await server.service.reviews.findOrCreateSession({
      userId: bobId, owner: 'acme', repo: 'widgets', kind: 'pr', prNumber: 1, prMeta: null, baseSha: fixture.base, headSha: fixture.head1,
    });
    const refused = await post(bobs.session.id, '/github/create-review', { event: 'APPROVE' }, bobCookie);
    expect(refused.status).toBe(403);
    expect(refused.body.error).toContain('Connect GitHub first');

    repoPulls[1].headSha = fixture.head2;
    try {
      const moved = await post(prSession.id, '/github/create-review', { event: 'APPROVE' });
      expect(moved.status).toBe(409);
      expect(moved.body.error).toContain('new session');
    } finally {
      repoPulls[1].headSha = fixture.head1;
    }
  });
});

describe('pulling comments', () => {
  it('brings in GitHub threads with their replies, resolves what the author resolved there, and leaves out lines this code lacks', async () => {
    const [sent] = await server.service.reviews.threadsForSession(aliceId, prSession.id);
    const base = { start_line: null, in_reply_to_id: null, created_at: '2026-09-03T10:00:00Z', pull: 1, review_id: null };
    github.comments.push(
      { ...base, id: 1, path: 'src.ts', line: 12, side: 'RIGHT', body: 'Why?', user: { login: 'carol', type: 'User' } },
      { ...base, id: 2, path: 'src.ts', line: 12, side: 'RIGHT', body: 'Because', in_reply_to_id: 1, user: { login: 'ci-bot', type: 'Bot' } },
      { ...base, id: 3, path: 'added.ts', line: 40, side: 'RIGHT', body: 'Past the end', user: { login: 'carol', type: 'User' } },
    );
    github.resolved.add(sent.githubCommentId!);

    const res = await post(prSession.id, '/github/pull-comments', { sessionId: prSession.id });
    expect(res.status).toBe(200);
    expect(res.body as PullCommentsResult).toEqual({ pulled: 1, skipped: 1, resolved: 1, resolutionUnavailable: false, unmapped: 1 });

    const threads = await server.service.reviews.threadsForSession(aliceId, prSession.id);
    expect(threads.find(t => t.id === sent.id)?.status).toBe('resolved');
    const pulled = threads.find(t => t.githubCommentId === 1)!;
    expect(pulled).toMatchObject({ filePath: 'src.ts', side: 'new', startLine: 12, endLine: 12 });
    expect(pulled.comments.map(c => [c.author, c.body])).toEqual([
      [{ name: 'carol', type: 'user' }, 'Why?'],
      [{ name: 'ci-bot', type: 'agent' }, 'Because'],
    ]);

    const again = await post(prSession.id, '/github/pull-comments', { sessionId: prSession.id });
    expect(again.body).toMatchObject({ pulled: 0, skipped: 2 });
  });

  it('refuses a body naming another session', async () => {
    expect((await post(prSession.id, '/github/pull-comments', { sessionId: shasSession.id })).status).toBe(400);
  });
});

describe('GitHub details', () => {
  it('says whether the viewer wrote the pull request, and lists the reviews worth showing', async () => {
    const res = await fetch(`${server.base}/s/${prSession.id}/api/github/details`, { headers: { cookie: aliceCookie } });
    const details = (await res.json()) as GitHubDetails;
    expect(details).toMatchObject({ prNumber: 1, viewerDidAuthor: true, headSha: fixture.head1, prAuthor: 'alice-gh' });
    expect(details.commentCount).toBe(github.comments.length);
    expect(details.reviews.map(r => [r.author, r.state])).toEqual([['carol', 'APPROVED']]);
  });
});
