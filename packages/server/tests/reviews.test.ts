import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { Store } from '../src/db.js';
import { AmbiguousIdError, Reviews, type ReviewSessionRecord } from '../src/reviews.js';
import { Users, WebSessions } from '../src/users.js';
import { removeDir, tempDir } from './helpers.js';

let dir: string;
let store: Store;
let reviews: Reviews;
let users: Users;
let alice: string;
let bob: string;
let session: ReviewSessionRecord;

const agent = { name: 'Agent', type: 'agent' as const };

beforeEach(() => {
  dir = tempDir('reviews');
  store = new Store(join(dir, 'diffity.db'));
  reviews = new Reviews(store);
  users = new Users(store, randomBytes(32));
  alice = users.findOrCreate('Alice@Example.com', 'Alice').id;
  bob = users.findOrCreate('bob@example.com').id;
  session = reviews.findOrCreateSession({
    userId: alice, owner: 'acme', repo: 'widgets', kind: 'shas', prNumber: null, prMeta: null,
    baseSha: 'a'.repeat(40), headSha: 'b'.repeat(40),
  }).session;
});

afterEach(() => {
  store.close();
  removeDir(dir);
});

function thread(userId = alice, sessionId = session.id) {
  return reviews.createThread({
    userId, sessionId, filePath: 'a.ts', side: 'new', startLine: 1, endLine: 2, body: 'Finding', author: agent,
  });
}

describe('users', () => {
  it('finds a user by normalised email and keeps the settings default', () => {
    const again = users.findOrCreate('alice@example.com');
    expect(again.id).toBe(alice);
    expect(again.name).toBe('Alice');
    expect(again.settings).toEqual({ shareReviews: 'private' });
    expect(users.get('missing')).toBeNull();
  });

  it('stores the GitHub token encrypted, and cannot read it back with another key', () => {
    users.setGitHubToken(alice, 'ghp_plaintext');
    expect(JSON.stringify(store.all('SELECT * FROM users'))).not.toContain('ghp_plaintext');
    expect(users.gitHubToken(alice)).toBe('ghp_plaintext');
    expect(new Users(store, randomBytes(32)).gitHubToken(alice)).toBeNull();
    users.setGitHubToken(alice, null);
    expect(users.gitHubToken(alice)).toBeNull();
  });

  it('keeps only a hash of the web session cookie, and honours expiry and sign-out', () => {
    const sessions = new WebSessions(store);
    const token = sessions.create(alice, 1_000);
    expect(JSON.stringify(store.all('SELECT * FROM web_sessions'))).not.toContain(token);
    expect(sessions.userFor(token, 2_000)).toBe(alice);
    expect(sessions.userFor(token, 1_000 + WebSessions.maxAgeSeconds() * 1000 + 1)).toBeNull();
    expect(sessions.userFor(undefined)).toBeNull();
    expect(sessions.userFor('forged')).toBeNull();
    sessions.destroy(token);
    sessions.destroy(undefined);
    expect(sessions.userFor(token, 2_000)).toBeNull();
  });
});

describe('isolation', () => {
  it('hides every session, thread, comment and tour of another user', () => {
    const t = thread();
    const tour = reviews.createTour(alice, session.id, 'Order', '');
    reviews.addTourStep(alice, tour.id, { filePath: 'a.ts', startLine: 1, endLine: 1, body: '', annotation: '' });

    expect(reviews.getSession(bob, session.id)).toBeNull();
    expect(reviews.getSession(bob, session.id.slice(0, 8))).toBeNull();
    expect(reviews.listSessions(bob)).toEqual([]);
    expect(reviews.getThread(bob, t.id)).toBeNull();
    expect(reviews.threadsForSession(bob, session.id)).toEqual([]);
    expect(reviews.findComment(bob, t.comments[0].id)).toBeNull();
    expect(reviews.getTour(bob, tour.id)).toBeNull();
    expect(reviews.toursForSession(bob, session.id)).toEqual([]);
  });

  it('lets no write of another user land', () => {
    const t = thread();
    const commentId = t.comments[0].id;
    const tour = reviews.createTour(alice, session.id, 'Order', '');

    reviews.updateThreadStatus(bob, t.id, 'dismissed');
    reviews.editComment(bob, commentId, 'hijacked');
    reviews.deleteComment(bob, commentId);
    reviews.deleteThread(bob, t.id);
    reviews.deleteThreadsForSession(bob, session.id);
    reviews.updateTourStatus(bob, tour.id, 'ready');
    reviews.deleteTour(bob, tour.id);
    reviews.startReview(bob, session.id, 'not mine');
    reviews.moveOpenWork(bob, [session.id], session.id);

    const after = reviews.getThread(alice, t.id)!;
    expect(after.status).toBe('open');
    expect(after.comments[0].body).toBe('Finding');
    expect(reviews.getTour(alice, tour.id)?.status).toBe('building');
    expect(reviews.getSession(alice, session.id)?.review.inProgress).toBe(false);
  });
});

describe('ids', () => {
  it('accepts a full id or an 8-character prefix, and refuses an ambiguous one', () => {
    const t = thread();
    expect(reviews.getThread(alice, t.id.slice(0, 8))?.id).toBe(t.id);
    expect(reviews.getThread(alice, t.id.slice(0, 7))).toBeNull();
    expect(reviews.getSession(alice, session.id.slice(0, 8))?.id).toBe(session.id);

    const first = reviews.createTour(alice, session.id, 'One', '');
    store.run("UPDATE tours SET id = 'abcdefgh-1' WHERE id = ?", first.id);
    const second = reviews.createTour(alice, session.id, 'Two', '');
    store.run("UPDATE tours SET id = 'abcdefgh-2' WHERE id = ?", second.id);
    expect(() => reviews.getTour(alice, 'abcdefgh')).toThrow(AmbiguousIdError);
    expect(reviews.getTour(alice, 'abcdefgh-2')?.topic).toBe('Two');
    expect(reviews.getTour(bob, 'abcdefgh')).toBeNull();
  });

  it('takes a prefix literally rather than as a pattern', () => {
    thread();
    expect(reviews.getThread(alice, '%%%%%%%%')).toBeNull();
    expect(reviews.getThread(alice, '________')).toBeNull();
  });
});

describe('threads', () => {
  it('reopens a finding when a person replies, not when an agent does', () => {
    const t = thread();
    reviews.updateThreadStatus(alice, t.id, 'resolved', 'Fixed it', agent);
    reviews.addReply(alice, t.id, 'Noted', agent, 'aside');
    expect(reviews.getThread(alice, t.id)?.status).toBe('resolved');
    reviews.addReply(alice, t.id, 'Not fixed', { name: 'Alice', type: 'user' });
    const after = reviews.getThread(alice, t.id)!;
    expect(after.status).toBe('open');
    expect(after.comments.map(c => c.body)).toEqual(['Finding', 'Fixed it', 'Noted', 'Not fixed']);
    expect(after.comments[2].kind).toBe('aside');
    expect(reviews.threadsForSession(alice, session.id, 'resolved')).toEqual([]);
  });

  it('takes the thread away with its last comment', () => {
    const t = thread();
    reviews.deleteComment(alice, t.comments[0].id);
    expect(reviews.getThread(alice, t.id)).toBeNull();
  });

  it('records a review run on the session', () => {
    reviews.startReview(alice, session.id, 'first pass');
    expect(reviews.getSession(alice, session.id)?.review).toMatchObject({ inProgress: true, note: 'first pass' });
    reviews.finishReview(alice, session.id);
    expect(reviews.getSession(alice, session.id)?.review.inProgress).toBe(false);
  });
});

describe('tours', () => {
  it('numbers steps in the order they are added and lists them with the tour', () => {
    const tour = reviews.createTour(alice, session.id, 'Order', 'why');
    reviews.addTourStep(alice, tour.id, { filePath: 'b.ts', startLine: 3, endLine: 4, body: 'second file', annotation: 'x' });
    reviews.addTourStep(alice, tour.id, { filePath: 'a.ts', startLine: 1, endLine: 1, body: 'first', annotation: '' });
    reviews.updateTourStatus(alice, tour.id, 'ready');
    const [listed] = reviews.toursForSession(alice, session.id);
    expect(listed.status).toBe('ready');
    expect(listed.steps.map(s => [s.sortOrder, s.filePath])).toEqual([[1, 'b.ts'], [2, 'a.ts']]);
    reviews.deleteTour(alice, tour.id);
    expect(reviews.toursForSession(alice, session.id)).toEqual([]);
  });
});
