import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import type { Db } from '../src/db.js';
import { AmbiguousIdError, Reviews, type ReviewSessionRecord } from '../src/reviews.js';
import { Users, WEB_SESSION_MAX_AGE_SECONDS, WebSessions } from '../src/users.js';
import { memoryDb } from './helpers.js';

let db: Db;
let reviews: Reviews;
let users: Users;
let alice: string;
let bob: string;
let session: ReviewSessionRecord;

const agent = { name: 'Agent', type: 'agent' as const };

beforeEach(async () => {
  db = await memoryDb();
  reviews = new Reviews(db);
  users = new Users(db, randomBytes(32));
  alice = (await users.findOrCreate('Alice@Example.com', 'Alice')).id;
  bob = (await users.findOrCreate('bob@example.com')).id;
  session = (await reviews.findOrCreateSession({
    userId: alice, owner: 'acme', repo: 'widgets', kind: 'shas', prNumber: null, prMeta: null,
    baseSha: 'a'.repeat(40), headSha: 'b'.repeat(40),
  })).session;
});

afterEach(async () => {
  await db.close();
});

function thread(userId = alice, sessionId = session.id) {
  return reviews.createThread({
    userId, sessionId, filePath: 'a.ts', side: 'new', startLine: 1, endLine: 2, body: 'Finding', author: agent,
  });
}

describe('users', () => {
  it('finds a user by normalised email', async () => {
    const again = await users.findOrCreate('alice@example.com');
    expect(again.id).toBe(alice);
    expect(again.name).toBe('Alice');
    expect(await users.get('missing')).toBeNull();
  });

  it('stores the GitHub token encrypted, and cannot read it back with another key', async () => {
    await users.setGitHubToken(alice, 'ghp_plaintext');
    expect(JSON.stringify(await db.query('SELECT * FROM users'))).not.toContain('ghp_plaintext');
    expect(await users.gitHubToken(alice)).toBe('ghp_plaintext');
    expect(await new Users(db, randomBytes(32)).gitHubToken(alice)).toBeNull();
    await users.setGitHubToken(alice, null);
    expect(await users.gitHubToken(alice)).toBeNull();
  });

  it('keeps only a hash of the web session cookie, and honours expiry and sign-out', async () => {
    const sessions = new WebSessions(db);
    const token = await sessions.create(alice, 1_000);
    expect(JSON.stringify(await db.query('SELECT * FROM web_sessions'))).not.toContain(token);
    expect(await sessions.userFor(token, 2_000)).toBe(alice);
    expect(await sessions.userFor(token, 1_000 + WEB_SESSION_MAX_AGE_SECONDS * 1000 + 1)).toBeNull();
    expect(await sessions.userFor(undefined)).toBeNull();
    expect(await sessions.userFor('forged')).toBeNull();
    await sessions.destroy(token);
    await sessions.destroy(undefined);
    expect(await sessions.userFor(token, 2_000)).toBeNull();
  });
});

describe('isolation', () => {
  it('hides every session, thread, comment and tour of another user', async () => {
    const t = await thread();
    const tour = await reviews.createTour(alice, session.id, 'Order', '');
    await reviews.addTourStep(alice, tour.id, { filePath: 'a.ts', startLine: 1, endLine: 1, body: '', annotation: '' });

    expect(await reviews.getSession(bob, session.id)).toBeNull();
    expect(await reviews.getSession(bob, session.id.slice(0, 8))).toBeNull();
    expect(await reviews.listSessions(bob)).toEqual([]);
    expect(await reviews.getThread(bob, t.id)).toBeNull();
    expect(await reviews.threadsForSession(bob, session.id)).toEqual([]);
    expect(await reviews.findComment(bob, t.comments[0].id)).toBeNull();
    expect(await reviews.getTour(bob, tour.id)).toBeNull();
    expect(await reviews.toursForSession(bob, session.id)).toEqual([]);
  });

  it('lets no write of another user land', async () => {
    const t = await thread();
    const commentId = t.comments[0].id;
    const tour = await reviews.createTour(alice, session.id, 'Order', '');

    await reviews.updateThreadStatus(bob, t.id, 'dismissed');
    await reviews.editComment(bob, commentId, 'hijacked');
    await reviews.deleteComment(bob, commentId);
    await reviews.deleteThread(bob, t.id);
    await reviews.deleteThreadsForSession(bob, session.id);
    await reviews.updateTourStatus(bob, tour.id, 'ready');
    await reviews.deleteTour(bob, tour.id);
    await reviews.startReview(bob, session.id, 'not mine');
    await reviews.moveOpenWork(bob, [session.id], session.id);

    const after = (await reviews.getThread(alice, t.id))!;
    expect(after.status).toBe('open');
    expect(after.comments[0].body).toBe('Finding');
    expect((await reviews.getTour(alice, tour.id))?.status).toBe('building');
    expect((await reviews.getSession(alice, session.id))?.review.inProgress).toBe(false);
  });
});

describe('ids', () => {
  it('accepts a full id or an 8-character prefix, and refuses an ambiguous one', async () => {
    const t = await thread();
    expect((await reviews.getThread(alice, t.id.slice(0, 8)))?.id).toBe(t.id);
    expect(await reviews.getThread(alice, t.id.slice(0, 7))).toBeNull();
    expect((await reviews.getSession(alice, session.id.slice(0, 8)))?.id).toBe(session.id);

    const first = await reviews.createTour(alice, session.id, 'One', '');
    await db.query("UPDATE tours SET id = 'abcdefgh-1' WHERE id = $1", [first.id]);
    const second = await reviews.createTour(alice, session.id, 'Two', '');
    await db.query("UPDATE tours SET id = 'abcdefgh-2' WHERE id = $1", [second.id]);
    await expect(reviews.getTour(alice, 'abcdefgh')).rejects.toThrow(AmbiguousIdError);
    expect((await reviews.getTour(alice, 'abcdefgh-2'))?.topic).toBe('Two');
    expect(await reviews.getTour(bob, 'abcdefgh')).toBeNull();
  });

  it('takes a prefix literally rather than as a pattern', async () => {
    await thread();
    expect(await reviews.getThread(alice, '%%%%%%%%')).toBeNull();
    expect(await reviews.getThread(alice, '________')).toBeNull();
  });
});

describe('threads', () => {
  it('reopens a finding when a person replies, not when an agent does', async () => {
    const t = await thread();
    await reviews.updateThreadStatus(alice, t.id, 'resolved', 'Fixed it', agent);
    await reviews.addReply(alice, t.id, 'Noted', agent, 'aside');
    expect((await reviews.getThread(alice, t.id))?.status).toBe('resolved');
    await reviews.addReply(alice, t.id, 'Not fixed', { name: 'Alice', type: 'user' });
    const after = (await reviews.getThread(alice, t.id))!;
    expect(after.status).toBe('open');
    expect(after.comments.map(c => c.body)).toEqual(['Finding', 'Fixed it', 'Noted', 'Not fixed']);
    expect(after.comments[2].kind).toBe('aside');
    expect(await reviews.threadsForSession(alice, session.id, 'resolved')).toEqual([]);
  });

  it('takes the thread away with its last comment', async () => {
    const t = await thread();
    await reviews.deleteComment(alice, t.comments[0].id);
    expect(await reviews.getThread(alice, t.id)).toBeNull();
  });

  it('records a review run on the session', async () => {
    await reviews.startReview(alice, session.id, 'first pass');
    expect((await reviews.getSession(alice, session.id))?.review).toMatchObject({ inProgress: true, note: 'first pass' });
    await reviews.finishReview(alice, session.id);
    expect((await reviews.getSession(alice, session.id))?.review.inProgress).toBe(false);
  });
});

describe('tours', () => {
  it('numbers steps in the order they are added and lists them with the tour', async () => {
    const tour = await reviews.createTour(alice, session.id, 'Order', 'why');
    await reviews.addTourStep(alice, tour.id, { filePath: 'b.ts', startLine: 3, endLine: 4, body: 'second file', annotation: 'x' });
    await reviews.addTourStep(alice, tour.id, { filePath: 'a.ts', startLine: 1, endLine: 1, body: 'first', annotation: '' });
    await reviews.updateTourStatus(alice, tour.id, 'ready');
    const [listed] = await reviews.toursForSession(alice, session.id);
    expect(listed.status).toBe('ready');
    expect(listed.steps.map(s => [s.sortOrder, s.filePath])).toEqual([[1, 'b.ts'], [2, 'a.ts']]);
    await reviews.deleteTour(alice, tour.id);
    expect(await reviews.toursForSession(alice, session.id)).toEqual([]);
  });
});
