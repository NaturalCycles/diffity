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
    additions: 10, deletions: 2, changedFiles: 3, updatedAt: '2026-09-02T10:00:00Z', ...over,
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

function deps(): TickDeps {
  return {
    forge,
    prepare: (snap) => { prepared.push(prId(snap)); return Promise.resolve(prepareResult(snap)); },
    removeWorktree: (worktree) => { removed.push(worktree); },
    log: () => {},
    now: () => '2026-09-02T12:00:00.000Z',
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
});
