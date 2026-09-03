import { describe, it, expect, beforeEach } from 'vitest';
import { InboxStore, prId } from '../src/inbox/store.js';
import { runTick, type Forge, type TickDeps } from '../src/inbox/tick.js';
import { buildView } from '../src/inbox/view.js';
import type { PrRef, PrSnapshot } from '@diffity/github';
import type { PrepareResult } from '../src/inbox/prepare.js';

function snapshot(over: Partial<PrSnapshot> = {}): PrSnapshot {
  return {
    owner: 'o', repo: 'r', number: 1, title: 'A change', url: 'https://github.com/o/r/pull/1',
    author: 'alice', isBot: false, isDraft: false, state: 'OPEN', headSha: 'aaa', baseRef: 'main',
    additions: 10, deletions: 2, changedFiles: 3, createdAt: '2026-09-02T10:00:00Z', updatedAt: '2026-09-02T10:00:00Z', ...over,
  };
}

/** A forge whose answers each test sets, so a tick runs without touching gh. */
class FakeForge implements Forge {
  login: string | null = 'me';
  requested: PrRef[] = [];
  snapshots = new Map<string, PrSnapshot | null>();

  set(snap: PrSnapshot, listed = true): void {
    this.snapshots.set(prId(snap), snap);
    if (listed) {
      this.requested.push({ owner: snap.owner, repo: snap.repo, number: snap.number });
    }
  }

  viewerLogin() { return Promise.resolve(this.login); }
  searchReviewRequested() { return Promise.resolve(this.requested); }
  viewPr(ref: PrRef) { return Promise.resolve(this.snapshots.get(prId(ref)) ?? null); }
}

let store: InboxStore;
let forge: FakeForge;
let prepared: string[];
let removed: string[];
let prepareResult: (snap: PrSnapshot) => PrepareResult;

function deps(over: Partial<TickDeps> = {}): TickDeps {
  return {
    forge,
    prepare: (snap) => { prepared.push(prId(snap)); return Promise.resolve(prepareResult(snap)); },
    removeWorktree: (worktree) => { removed.push(worktree); },
    log: () => {},
    now: () => '2026-09-02T12:00:00.000Z',
    maxPrepared: 100,
    ...over,
  };
}

beforeEach(() => {
  store = new InboxStore(':memory:');
  forge = new FakeForge();
  prepared = [];
  removed = [];
  prepareResult = (snap) => ({
    kind: 'prepared', headSha: snap.headSha, bundlePath: `/b/${snap.number}.json`,
    worktree: `/wt/${snap.number}`, logPath: `/l/${snap.number}.log`, at: '2026-09-02T12:00:00.000Z',
  });
});

describe('runTick', () => {
  it('prepares a fresh requested pull request and records where it landed', async () => {
    forge.set(snapshot());
    await runTick(store, deps());

    expect(prepared).toEqual(['o/r#1']);
    const pr = store.get('o/r#1')!;
    expect(pr.status).toBe('prepared');
    expect(pr.preparedHeadSha).toBe('aaa');
    expect(pr.bundlePath).toBe('/b/1.json');
  });

  it('does not touch an agent for a draft, a bot, or the reviewer\'s own PR', async () => {
    forge.set(snapshot({ number: 1, isDraft: true }));
    forge.set(snapshot({ number: 2, isBot: true, author: 'ncrobot1' }));
    forge.set(snapshot({ number: 3, author: 'me' }));
    await runTick(store, deps());

    expect(prepared).toEqual([]);
    expect(store.get('o/r#1')!.status).toBe('draft');
    expect(store.get('o/r#2')!.status).toBe('skipped');
    expect(store.get('o/r#3')!.status).toBe('skipped');
  });

  it('records a skip verdict without preparing again next tick', async () => {
    forge.set(snapshot());
    prepareResult = () => ({ kind: 'skipped', reason: 'payments PR', logPath: '/l/1.log' });
    await runTick(store, deps());
    expect(store.get('o/r#1')!.status).toBe('skipped');
    expect(store.get('o/r#1')!.statusReason).toBe('payments PR');

    prepared = [];
    await runTick(store, deps());
    expect(prepared).toEqual([]);
  });

  it('re-prepares when a new commit arrives, and marks the interim stale', async () => {
    forge.set(snapshot({ headSha: 'aaa' }));
    await runTick(store, deps());
    expect(store.get('o/r#1')!.status).toBe('prepared');

    forge.snapshots.set('o/r#1', snapshot({ headSha: 'bbb' }));
    prepared = [];
    await runTick(store, deps());
    expect(prepared).toEqual(['o/r#1']);
    expect(store.get('o/r#1')!.preparedHeadSha).toBe('bbb');
  });

  it('retires a merged pull request and reclaims its worktree', async () => {
    forge.set(snapshot());
    await runTick(store, deps());

    forge.requested = [];
    forge.snapshots.set('o/r#1', snapshot({ state: 'MERGED' }));
    await runTick(store, deps());

    const pr = store.get('o/r#1')!;
    expect(pr.status).toBe('done');
    expect(pr.statusReason).toBe('merged');
    expect(removed).toEqual(['/wt/1']);
    expect(pr.worktreePath).toBeNull();
  });

  it('sorts the ready list smallest first for the surface', async () => {
    forge.set(snapshot({ number: 1, additions: 200, deletions: 100 }));
    forge.set(snapshot({ number: 2, additions: 3, deletions: 1 }));
    await runTick(store, deps());

    const view = buildView(store, 'http://localhost:5390', '2026-09-02T12:00:00.000Z');
    expect(view.ready.map(row => row.number)).toEqual([2, 1]);
    expect(view.ready[0].openUrl).toBe('http://localhost:5390/open/o%2Fr%232');
  });

  it('holds a failed preparation with its reason and log, and stops after the attempt cap', async () => {
    forge.set(snapshot());
    prepareResult = () => ({ kind: 'failed', reason: 'no local clone', worktree: null, logPath: '/l/1.log' });

    for (let i = 0; i < 5; i++) {
      prepared = [];
      await runTick(store, deps());
    }

    const pr = store.get('o/r#1')!;
    expect(pr.status).toBe('failed');
    expect(pr.statusReason).toBe('no local clone');
    expect(pr.logPath).toBe('/l/1.log');
    // Three attempts at the head, then it stops spending an agent on it.
    expect(pr.attempts).toBe(3);
  });

  it('picks up a preparation a previous run left unfinished', async () => {
    forge.set(snapshot());
    store.observe(snapshot(), true, 'now');
    store.setStatus('o/r#1', 'preparing');

    await runTick(store, deps());

    expect(prepared).toEqual(['o/r#1']);
    expect(store.get('o/r#1')!.status).toBe('prepared');
  });

  it('leaves a row untouched when its detail view fails this tick', async () => {
    forge.set(snapshot());
    await runTick(store, deps());
    expect(store.get('o/r#1')!.status).toBe('prepared');

    forge.snapshots.set('o/r#1', null);
    prepared = [];
    await runTick(store, deps());
    expect(prepared).toEqual([]);
    expect(store.get('o/r#1')!.status).toBe('prepared');
  });

  it('prepares no more than maxPrepared at once, smallest first, and leaves the rest queued', async () => {
    forge.set(snapshot({ number: 1, additions: 300, deletions: 0 }));
    forge.set(snapshot({ number: 2, additions: 10, deletions: 0 }));
    forge.set(snapshot({ number: 3, additions: 50, deletions: 0 }));
    await runTick(store, deps({ maxPrepared: 2 }));

    expect(prepared).toEqual(['o/r#2', 'o/r#3']);
    const waiting = store.get('o/r#1')!;
    expect(waiting.status).toBe('queued');
    expect(waiting.statusReason).toBe('waiting: 2 reviews already prepared');
  });

  it('fills a slot once a prepared review is no longer requested', async () => {
    forge.set(snapshot({ number: 1, additions: 300, deletions: 0 }));
    forge.set(snapshot({ number: 2, additions: 10, deletions: 0 }));
    await runTick(store, deps({ maxPrepared: 1 }));
    expect(prepared).toEqual(['o/r#2']);

    // The review on #2 is posted: GitHub withdraws the request, and the next tick moves on to #1.
    forge.requested = forge.requested.filter(ref => ref.number !== 2);
    prepared = [];
    await runTick(store, deps({ maxPrepared: 1 }));
    expect(store.get('o/r#2')!.status).toBe('hidden');
    expect(prepared).toEqual(['o/r#1']);
  });

  it('refreshes a stale review even at the cap, without preparing a queued one', async () => {
    forge.set(snapshot({ number: 1, additions: 10, deletions: 0 }));
    forge.set(snapshot({ number: 2, additions: 300, deletions: 0 }));
    await runTick(store, deps({ maxPrepared: 1 }));
    expect(prepared).toEqual(['o/r#1']);

    forge.snapshots.set('o/r#1', snapshot({ number: 1, additions: 10, deletions: 0, headSha: 'bbb' }));
    prepared = [];
    await runTick(store, deps({ maxPrepared: 1 }));
    expect(prepared).toEqual(['o/r#1']);
    expect(store.get('o/r#1')!.preparedHeadSha).toBe('bbb');
    expect(store.get('o/r#2')!.status).toBe('queued');
  });

  it('leaves a dismissed pull request alone at that head, and its slot goes to the next in line', async () => {
    forge.set(snapshot({ number: 1, additions: 10, deletions: 0 }));
    forge.set(snapshot({ number: 2, additions: 400, deletions: 0 }));
    await runTick(store, deps({ maxPrepared: 1 }));
    store.setStatus('o/r#1', 'dismissed', 'dismissed by the reviewer');

    prepared = [];
    await runTick(store, deps({ maxPrepared: 1 }));
    expect(store.get('o/r#1')!.status).toBe('dismissed');
    expect(prepared).toEqual(['o/r#2']);

    const view = buildView(store, 'http://localhost:5390', '2026-09-02T12:00:00.000Z');
    expect(view.ready.map(row => row.number)).toEqual([2]);
    expect(view.other).toEqual([]);
  });

  it('takes a dismissed pull request from the top once it has new commits', async () => {
    forge.set(snapshot({ number: 1 }));
    await runTick(store, deps());
    store.setStatus('o/r#1', 'dismissed', 'dismissed by the reviewer');

    prepared = [];
    forge.snapshots.set('o/r#1', snapshot({ number: 1, headSha: 'bbb' }));
    await runTick(store, deps());
    expect(prepared).toEqual(['o/r#1']);
    expect(store.get('o/r#1')!.status).toBe('prepared');
    expect(store.get('o/r#1')!.preparedHeadSha).toBe('bbb');
  });

  it('carries the forge\'s timestamps onto the rows', async () => {
    forge.set(snapshot({ number: 1, createdAt: '2026-09-01T08:00:00Z', updatedAt: '2026-09-02T10:00:00Z' }));
    await runTick(store, deps());
    const [row] = buildView(store, 'http://localhost:5390', '2026-09-02T12:00:00.000Z').ready;
    expect(row.createdAt).toBe('2026-09-01T08:00:00Z');
    expect(row.updatedAt).toBe('2026-09-02T10:00:00Z');
  });

  it('offers a dismiss link for every row but one being prepared', async () => {
    forge.set(snapshot({ number: 1, additions: 10, deletions: 0 }));
    forge.set(snapshot({ number: 2, additions: 300, deletions: 0 }));
    await runTick(store, deps({ maxPrepared: 1 }));
    store.observe(snapshot({ number: 3 }), true, 'now');
    store.setStatus('o/r#3', 'preparing');

    const view = buildView(store, 'http://localhost:5390', '2026-09-02T12:00:00.000Z');
    expect(view.ready[0].dismissUrl).toBe('http://localhost:5390/dismiss/o%2Fr%231');
    const byNumber = Object.fromEntries(view.working.map(row => [row.number, row.dismissUrl]));
    expect(byNumber).toEqual({ 2: 'http://localhost:5390/dismiss/o%2Fr%232', 3: null });
  });
});
