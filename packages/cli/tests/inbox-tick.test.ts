import { describe, it, expect, beforeEach } from 'vitest';
import { InboxStore, prId } from '../src/inbox/store.js';
import { prepareBumped, runTick, type Forge, type TickDeps } from '../src/inbox/tick.js';
import { buildView } from '../src/inbox/view.js';
import { localHhMm } from '../src/inbox/runs.js';
import type { PrRef, PrSnapshot } from '@diffity/github';
import type { PrepareResult, RunLog } from '../src/inbox/prepare.js';

function snapshot(over: Partial<PrSnapshot> = {}): PrSnapshot {
  return {
    owner: 'o', repo: 'r', number: 1, title: 'A change', body: '', url: 'https://github.com/o/r/pull/1',
    author: 'alice', isBot: false, isDraft: false, state: 'OPEN', headSha: 'aaa', baseRef: 'main',
    additions: 10, deletions: 2, changedFiles: 3, createdAt: '2026-09-02T10:00:00Z', updatedAt: '2026-09-02T10:00:00Z',
    checks: [], files: [], ...over,
  };
}

/** One agent run as `preparePr` reports it: two minutes, with what it spent. */
function run(over: Partial<RunLog> = {}): RunLog {
  return {
    startedAt: '2026-09-02T11:58:00.000Z',
    endedAt: '2026-09-02T12:00:00.000Z',
    stats: {
      costUsd: 1.2, durationMs: 120_000, turns: 9, inputTokens: 10, outputTokens: 2000,
      cacheReadTokens: 5000, cacheWriteTokens: 100, models: ['claude-x'], isError: false, subtype: 'success',
    },
    ...over,
  };
}

/** A forge whose answers each test sets, so a tick runs without touching gh. */
class FakeForge implements Forge {
  login: string | null = 'me';
  requested: PrRef[] = [];
  snapshots = new Map<string, PrSnapshot | null>();
  views: string[] = [];

  set(snap: PrSnapshot, listed = true): void {
    this.snapshots.set(prId(snap), snap);
    if (listed) {
      this.requested.push({ owner: snap.owner, repo: snap.repo, number: snap.number });
    }
  }

  viewerLogin() { return Promise.resolve(this.login); }
  searchReviewRequested() { return Promise.resolve(this.requested); }
  viewPr(ref: PrRef) {
    this.views.push(prId(ref));
    return Promise.resolve(this.snapshots.get(prId(ref)) ?? null);
  }
}

let store: InboxStore;
let forge: FakeForge;
let prepared: string[];
let bumpedFlags: boolean[];
let removed: string[];
let pauses: string[];
let prepareResult: (snap: PrSnapshot) => PrepareResult;

function deps(over: Partial<TickDeps> = {}): TickDeps {
  return {
    forge,
    prepare: (snap, opts) => { prepared.push(prId(snap)); bumpedFlags.push(opts.bumped); return Promise.resolve(prepareResult(snap)); },
    removeWorktree: (worktree) => { removed.push(worktree); },
    log: () => {},
    now: () => '2026-09-02T12:00:00.000Z',
    inFlight: new Set<string>(),
    maxPrepared: 100,
    waitForCi: false,
    skipTitles: [],
    alertPaths: [],
    agentModel: 'the-configured-model',
    validateModel: 'the-checking-model',
    pauseUntil: until => { pauses.push(until); },
    ...over,
  };
}

beforeEach(() => {
  store = new InboxStore(':memory:');
  forge = new FakeForge();
  prepared = [];
  bumpedFlags = [];
  removed = [];
  pauses = [];
  prepareResult = (snap) => ({
    kind: 'prepared', headSha: snap.headSha, bundlePath: `/b/${snap.number}.json`,
    worktree: `/wt/${snap.number}`, logPath: `/l/${snap.number}.log`, at: '2026-09-02T12:00:00.000Z',
    summary: '1 P2', alert: snap.number === 2 ? 'touches auth' : null,
    alertFindings: snap.number === 2 ? ['cf15e689', '7b2a10c4'] : [], posted: null, run: run(),
    validation: 'not-needed', validateRun: null,
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
    prepareResult = () => ({ kind: 'skipped', reason: 'payments PR', logPath: '/l/1.log', run: run() });
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

  it('sorts the ready list smallest first for the surface, carrying the summary', async () => {
    forge.set(snapshot({ number: 1, additions: 200, deletions: 100 }));
    forge.set(snapshot({ number: 3, additions: 3, deletions: 1 }));
    await runTick(store, deps());

    const view = buildView(store, 'http://localhost:5390', '2026-09-02T12:00:00.000Z');
    expect(view.ready.map(row => row.number)).toEqual([3, 1]);
    expect(view.ready.map(row => [row.summary, row.alert])).toEqual([['1 P2', null], ['1 P2', null]]);
    expect(view.ready[0].openUrl).toBe('http://localhost:5390/open/o%2Fr%233');
  });

  it('lists the one the agent alerted on above the rest, with the findings it named', async () => {
    forge.set(snapshot({ number: 1, additions: 3, deletions: 1 }));
    forge.set(snapshot({ number: 2, additions: 200, deletions: 100 }));
    await runTick(store, deps());

    const view = buildView(store, 'http://localhost:5390', '2026-09-02T12:00:00.000Z');
    // Number 2 is the one the fake agent alerts on, and its size does not put it behind number 1.
    expect(view.alerted.map(row => [row.number, row.alert, row.alertFindings]))
      .toEqual([[2, 'touches auth', ['cf15e689', '7b2a10c4']]]);
    expect(view.ready.map(row => row.number)).toEqual([1]);
    expect(view.other).toEqual([]);
    expect(view.alerted[0].openUrl).toBe('http://localhost:5390/open/o%2Fr%232');
  });

  it('alerts on the reviewer\'s own paths when the agent raised nothing, and defers to it when it did', async () => {
    forge.set(snapshot({ number: 1, files: [{ path: 'README.md', additions: 1, deletions: 0 }, { path: 'packages/shared/src/model/user.ts', additions: 2, deletions: 1 }] }));
    forge.set(snapshot({ number: 2, files: [{ path: 'packages/shared/src/model/user.ts', additions: 2, deletions: 1 }] }));
    forge.set(snapshot({ number: 3, files: [{ path: 'README.md', additions: 1, deletions: 0 }] }));
    await runTick(store, deps({ alertPaths: ['packages/shared/src/model/**'] }));

    expect(store.get('o/r#1')!.alert).toBe('touches packages/shared/src/model/user.ts');
    // Number 2 is the one the fake agent alerts on: its own words stand.
    expect(store.get('o/r#2')!.alert).toBe('touches auth');
    expect(store.get('o/r#3')!.alert).toBeNull();
    // Only the agent names findings: the path alert has the reviewer's own rule behind it and none.
    expect(store.get('o/r#1')!.alertFindings).toEqual([]);
    expect(store.get('o/r#2')!.alertFindings).toEqual(['cf15e689', '7b2a10c4']);
  });

  it('carries what CI said about each head to the surface', async () => {
    forge.set(snapshot({ number: 1, checks: [{ name: 'check-job', status: 'success' }] }));
    forge.set(snapshot({ number: 2, checks: [{ name: 'check-job', status: 'pending' }] }));
    forge.set(snapshot({ number: 3 }));
    await runTick(store, deps());

    const view = buildView(store, 'http://localhost:5390', '2026-09-02T12:00:00.000Z');
    expect(new Map([...view.alerted, ...view.ready].map(row => [row.number, row.ciState])))
      .toEqual(new Map([[1, 'passing'], [2, 'running'], [3, 'none']]));
  });

  it('leaves a pull request queued while its CI runs, and skips one whose CI failed', async () => {
    forge.set(snapshot({ number: 1, checks: [{ name: 'check-job', status: 'pending' }] }));
    forge.set(snapshot({ number: 2, checks: [{ name: 'check-job', status: 'failure' }] }));
    forge.set(snapshot({ number: 3, checks: [{ name: 'check-job', status: 'success' }] }));
    await runTick(store, deps({ waitForCi: true }));

    expect(prepared).toEqual(['o/r#3']);
    expect(store.get('o/r#1')!.statusReason).toBe('waiting: CI running (1 checks)');
    expect(store.get('o/r#2')!.status).toBe('skipped');
    expect(store.get('o/r#2')!.statusReason).toBe('CI failed: check-job');
  });

  it('never reaches an agent with a title the reviewer said to skip', async () => {
    forge.set(snapshot({ number: 1, title: 'feat(payments): a new card' }));
    forge.set(snapshot({ number: 2, title: 'chore: 1.2.3 Release' }));
    forge.set(snapshot({ number: 3, title: 'feat: a new card' }));
    await runTick(store, deps({ skipTitles: ['\\(payments\\)', 'Release$'] }));

    expect(prepared).toEqual(['o/r#3']);
    expect(store.get('o/r#1')!.status).toBe('skipped');
    expect(store.get('o/r#1')!.statusReason).toBe('title matches /\\(payments\\)/');
    expect(store.get('o/r#2')!.statusReason).toBe('title matches /Release$/');
  });

  it('holds a failed preparation with its reason and log, and stops after the attempt cap', async () => {
    forge.set(snapshot());
    prepareResult = () => ({ kind: 'failed', failure: 'agent', reason: 'no local clone', worktree: null, logPath: '/l/1.log', run: run() });

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
    // Number 2 is the one the fake agent alerts on, so it is listed above the rest.
    expect(view.alerted.map(row => row.number)).toEqual([2]);
    expect(view.ready).toEqual([]);
    expect(view.other).toEqual([]);
    // Listed as dismissed, with a way back and no second dismiss.
    expect(view.dismissed.map(row => [row.number, row.prepareUrl, row.dismissUrl]))
      .toEqual([[1, 'http://localhost:5390/prepare/o%2Fr%231', null]]);
  });

  it('retires a dismissed pull request once it is merged, like any other', async () => {
    forge.set(snapshot({ number: 1 }));
    await runTick(store, deps());
    store.setStatus('o/r#1', 'dismissed', 'dismissed by the reviewer');

    forge.requested = [];
    forge.snapshots.set('o/r#1', snapshot({ number: 1, state: 'MERGED' }));
    await runTick(store, deps());
    expect(store.get('o/r#1')!.status).toBe('done');
    expect(buildView(store, 'http://localhost:5390', 'now').dismissed).toEqual([]);
  });

  it('does not prepare a pull request dismissed while the tick was busy with another', async () => {
    forge.set(snapshot({ number: 1, additions: 10, deletions: 0 }));
    forge.set(snapshot({ number: 2, additions: 20, deletions: 0 }));
    const prepare = (snap: PrSnapshot) => {
      prepared.push(prId(snap));
      // The reviewer dismisses #2 from the page while #1 is being prepared.
      if (snap.number === 1) {
        store.setStatus('o/r#2', 'dismissed', 'dismissed by the reviewer');
      }
      return Promise.resolve(prepareResult(snap));
    };
    await runTick(store, deps({ prepare }));

    expect(prepared).toEqual(['o/r#1']);
    expect(store.get('o/r#2')!.status).toBe('dismissed');
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

  it('prepares a bumped pull request first and past the cap, then the bump is spent', async () => {
    forge.set(snapshot({ number: 1, additions: 10, deletions: 0 }));
    forge.set(snapshot({ number: 2, additions: 20, deletions: 0 }));
    forge.set(snapshot({ number: 3, additions: 300, deletions: 0 }));
    await runTick(store, deps({ maxPrepared: 1 }));
    expect(prepared).toEqual(['o/r#1']);
    expect(bumpedFlags).toEqual([false]);

    store.bump('o/r#3', '2026-09-07T10:00:00Z');
    prepared = [];
    bumpedFlags = [];
    await runTick(store, deps({ maxPrepared: 1 }));

    expect(prepared).toEqual(['o/r#3']);
    expect(bumpedFlags).toEqual([true]);
    expect(store.get('o/r#3')!.status).toBe('prepared');
    expect(store.get('o/r#3')!.bumpedAt).toBeNull();
    expect(store.get('o/r#2')!.status).toBe('queued');
  });

  it('logs the preparation as a run, with the models it spent on', async () => {
    forge.set(snapshot());
    await runTick(store, deps());

    expect(store.runs({})).toHaveLength(1);
    expect(store.runs({})[0]).toMatchObject({
      prId: 'o/r#1', headSha: 'aaa', phase: 'prepare', outcome: 'prepared', model: 'claude-x',
      turns: 9, costUsd: 1.2, durationMs: 120_000, outputTokens: 2000, note: null,
    });
  });

  it('logs a skip and a timeout under their own outcomes, and nothing when no agent ran', async () => {
    forge.set(snapshot());
    prepareResult = () => ({ kind: 'skipped', reason: 'payments PR', logPath: '/l/1.log', run: run() });
    await runTick(store, deps());
    expect(store.runs({}).map(row => [row.outcome, row.note])).toEqual([['skipped', 'payments PR']]);

    forge.snapshots.set('o/r#1', snapshot({ headSha: 'bbb' }));
    prepareResult = () => ({ kind: 'failed', failure: 'timeout', reason: 'the agent did not finish within 30 minutes', worktree: null, logPath: '/l/1.log', run: run() });
    await runTick(store, deps());
    expect(store.runs({}).map(row => row.outcome)).toEqual(['timeout', 'skipped']);

    // A worktree that could not be cut never got as far as an agent, so there is no run to log.
    forge.snapshots.set('o/r#1', snapshot({ headSha: 'ccc' }));
    prepareResult = () => ({ kind: 'failed', failure: 'worktree', reason: 'No local clone', worktree: null, logPath: null, run: run() });
    await runTick(store, deps());
    expect(store.runs({}).map(row => row.outcome)).toEqual(['timeout', 'skipped']);
  });

  it('logs the pass that checked the draft beside the one that drafted it', async () => {
    forge.set(snapshot());
    const logged: string[] = [];
    prepareResult = snap => ({
      kind: 'prepared', headSha: snap.headSha, bundlePath: '/b.json', worktree: '/wt', logPath: '/l.log',
      at: '2026-09-02T12:00:00.000Z', summary: '1 P1', alert: null, alertFindings: [], posted: null, run: run(),
      validation: 'validated',
      validateRun: {
        startedAt: '2026-09-02T12:00:00.000Z', endedAt: '2026-09-02T12:03:00.000Z',
        stats: null, outcome: 'validated', note: null,
      },
    });
    await runTick(store, deps({ log: message => { logged.push(message); } }));

    const runs = store.runs({});
    expect(runs.map(row => [row.phase, row.outcome, row.model])).toEqual([
      ['validate', 'validated', 'the-checking-model'],
      ['prepare', 'prepared', 'claude-x'],
    ]);
    expect(runs.find(row => row.phase === 'validate')).toMatchObject({ headSha: 'aaa', durationMs: 180_000, note: null });
    expect(logged.some(line => line.includes('unchecked'))).toBe(false);
  });

  it('logs an unchecked draft with the reason, and still marks it prepared', async () => {
    forge.set(snapshot());
    const logged: string[] = [];
    prepareResult = snap => ({
      kind: 'prepared', headSha: snap.headSha, bundlePath: '/b.json', worktree: '/wt', logPath: '/l.log',
      at: '2026-09-02T12:00:00.000Z', summary: '1 P1 \u00b7 unchecked', alert: null, alertFindings: [], posted: null, run: run(),
      validation: 'unchecked',
      validateRun: {
        startedAt: '2026-09-02T12:00:00.000Z', endedAt: '2026-09-02T12:15:00.000Z', stats: null,
        outcome: 'timeout', note: 'the checking agent did not finish within 15 minutes',
      },
    });
    await runTick(store, deps({ log: message => { logged.push(message); } }));

    expect(store.get('o/r#1')?.status).toBe('prepared');
    expect(store.get('o/r#1')?.summary).toBe('1 P1 \u00b7 unchecked');
    expect(store.runs({}).find(row => row.phase === 'validate'))
      .toMatchObject({ outcome: 'timeout', note: 'the checking agent did not finish within 15 minutes' });
    expect(logged).toContain('o/r#1: the drafted findings went unchecked \u2014 the checking agent did not finish within 15 minutes');
  });

  it('records the configured model when the run did not say which it used', async () => {
    forge.set(snapshot());
    prepareResult = snap => ({
      kind: 'prepared', headSha: snap.headSha, bundlePath: '/b.json', worktree: '/wt', logPath: '/l.log',
      at: '2026-09-02T12:00:00.000Z', summary: null, alert: null, alertFindings: [], posted: null, run: run({ stats: null }),
      validation: 'not-needed', validateRun: null,
    });
    await runTick(store, deps());

    // No stats at all: the wall clock the daemon measured stands in for the duration.
    expect(store.runs({})[0]).toMatchObject({ model: 'the-configured-model', durationMs: 120_000, turns: null, costUsd: null });
  });

  it('waits out a session limit: the row keeps its retries and preparing is paused', async () => {
    forge.set(snapshot());
    prepareResult = () => ({
      kind: 'failed', failure: 'rate-limit', reason: 'waiting: Claude session limit until 14:00',
      worktree: null, logPath: '/l/1.log', resetsAt: '2026-09-02T14:00:00.000Z', run: run(),
    });
    await runTick(store, deps());

    const pr = store.get('o/r#1')!;
    expect(pr.status).toBe('queued');
    expect(pr.statusReason).toBe('waiting: Claude session limit until 14:00');
    expect(pr.attempts).toBe(0);
    expect(pr.logPath).toBe('/l/1.log');
    expect(pauses).toEqual(['2026-09-02T14:00:00.000Z']);
    expect(store.runs({})[0]).toMatchObject({ outcome: 'rate-limited', note: 'waiting: Claude session limit until 14:00' });
  });

  it('pauses half an hour when the limit message named no time', async () => {
    forge.set(snapshot());
    prepareResult = () => ({
      kind: 'failed', failure: 'rate-limit', reason: 'waiting: Claude session limit, retrying in 30 minutes',
      worktree: null, logPath: null, resetsAt: null, run: run(),
    });
    await runTick(store, deps());
    expect(pauses).toEqual(['2026-09-02T12:30:00.000Z']);
  });

  it('polls and reconciles while paused, but prepares nothing until it lifts', async () => {
    forge.set(snapshot());
    const until = '2026-09-02T14:00:00.000Z';
    const reason = `waiting: preparing paused until ${localHhMm(until)}`;
    await runTick(store, deps({ pausedUntil: () => until }));

    expect(prepared).toEqual([]);
    expect(store.get('o/r#1')!.status).toBe('queued');
    expect(store.get('o/r#1')!.statusReason).toBe(reason);
    expect(store.runs({})).toEqual([]);

    // The reconcile clears a queued row's reason every tick, so the pause has to put it back.
    await runTick(store, deps({ pausedUntil: () => until }));
    expect(store.get('o/r#1')!.statusReason).toBe(reason);

    await runTick(store, deps());
    expect(prepared).toEqual(['o/r#1']);
    expect(store.get('o/r#1')!.status).toBe('prepared');
  });

  it('leaves a pull request alone while a preparation for it is running', async () => {
    forge.set(snapshot());
    store.observe(snapshot(), true, 'now');
    store.setStatus('o/r#1', 'preparing', 'a bump got there first');

    await runTick(store, deps({ inFlight: new Set(['o/r#1']) }));

    expect(prepared).toEqual([]);
    expect(store.get('o/r#1')!.status).toBe('preparing');
    expect(store.get('o/r#1')!.statusReason).toBe('a bump got there first');

    // The same row with nothing running for it is a crash's leftover, and is taken up again.
    await runTick(store, deps());
    expect(prepared).toEqual(['o/r#1']);
    expect(store.get('o/r#1')!.status).toBe('prepared');
  });

  it('does not prepare a pull request a bump started preparing while the tick was busy', async () => {
    forge.set(snapshot({ number: 1, additions: 10, deletions: 0 }));
    forge.set(snapshot({ number: 2, additions: 20, deletions: 0 }));
    const inFlight = new Set<string>();
    const prepare = (snap: PrSnapshot) => {
      prepared.push(prId(snap));
      // A bump takes #2 on while this tick is on #1.
      if (snap.number === 1) {
        inFlight.add('o/r#2');
      }
      return Promise.resolve(prepareResult(snap));
    };
    await runTick(store, deps({ prepare, inFlight }));

    expect(prepared).toEqual(['o/r#1']);
    expect(store.get('o/r#2')!.status).toBe('queued');
  });

  it('offers a bump on queued, skipped and failed rows only, and lists a bumped row first', async () => {
    forge.set(snapshot({ number: 1, additions: 10, deletions: 0 }));
    forge.set(snapshot({ number: 2, additions: 20, deletions: 0 }));
    forge.set(snapshot({ number: 3, additions: 30, deletions: 0 }));
    await runTick(store, deps({ maxPrepared: 1 }));
    store.bump('o/r#3', '2026-09-07T10:00:00Z');

    const view = buildView(store, 'http://localhost:5390', '2026-09-02T12:00:00.000Z');
    expect(view.ready[0].prepareUrl).toBeNull();
    expect(view.working.map(row => [row.number, row.bumped, row.prepareUrl])).toEqual([
      [3, true, null],
      [2, false, 'http://localhost:5390/prepare/o%2Fr%232'],
    ]);
  });
});

describe('prepareBumped', () => {
  /** A row the reviewer has just pressed \u2191 on, as `handleBump` leaves it. */
  function bumpedRow(over: Partial<PrSnapshot> = {}): PrSnapshot {
    const snap = snapshot(over);
    store.observe(snap, true, '2026-09-02T11:00:00.000Z');
    store.bump(prId(snap), '2026-09-07T10:00:00Z');
    // Not listed: the bump has no poll behind it, so the search is never asked.
    forge.set(snap, false);
    return snap;
  }

  it('prepares the bumped pull request there and then, and spends the bump', async () => {
    bumpedRow();

    await prepareBumped(store, deps(), 'o/r#1');

    expect(prepared).toEqual(['o/r#1']);
    expect(bumpedFlags).toEqual([true]);
    expect(store.get('o/r#1')!.status).toBe('prepared');
    expect(store.get('o/r#1')!.bumpedAt).toBeNull();
  });

  it('prepares past the CI hold and the reviewer\'s own title patterns', async () => {
    bumpedRow({ title: 'chore: 1.2.3 Release', checks: [{ name: 'check-job', status: 'failure' }] });

    await prepareBumped(store, deps({ waitForCi: true, skipTitles: ['Release$'] }), 'o/r#1');

    expect(prepared).toEqual(['o/r#1']);
    expect(store.get('o/r#1')!.status).toBe('prepared');
  });

  it('leaves it queued while preparing is paused', async () => {
    bumpedRow();
    const until = '2026-09-02T14:00:00.000Z';

    await prepareBumped(store, deps({ pausedUntil: () => until }), 'o/r#1');

    expect(prepared).toEqual([]);
    const pr = store.get('o/r#1')!;
    expect(pr.status).toBe('queued');
    expect(pr.statusReason).toBe(`waiting: preparing paused until ${localHhMm(until)}`);
    // The bump is not spent: the pause lifts and the queue takes it first.
    expect(pr.bumpedAt).not.toBeNull();
  });

  it('does nothing when a preparation for it is already running', async () => {
    bumpedRow();

    await prepareBumped(store, deps({ inFlight: new Set(['o/r#1']) }), 'o/r#1');

    expect(prepared).toEqual([]);
    expect(store.get('o/r#1')!.status).toBe('queued');
    expect(store.get('o/r#1')!.bumpedAt).not.toBeNull();
  });

  it('retires one merged since it was queued, and leaves a draft a draft', async () => {
    bumpedRow({ state: 'MERGED' });

    await prepareBumped(store, deps(), 'o/r#1');

    expect(prepared).toEqual([]);
    expect(store.get('o/r#1')!.status).toBe('done');
    expect(store.get('o/r#1')!.statusReason).toBe('merged');

    bumpedRow({ number: 2, isDraft: true });
    await prepareBumped(store, deps(), 'o/r#2');
    expect(prepared).toEqual([]);
    expect(store.get('o/r#2')!.status).toBe('draft');
  });

  it('says so when there is no such row, or the forge cannot be read', async () => {
    const logged: string[] = [];

    await prepareBumped(store, deps({ log: message => { logged.push(message); } }), 'o/r#9');
    expect(logged.some(line => line.includes('no such pull request'))).toBe(true);

    store.observe(snapshot(), true, 'now');
    await prepareBumped(store, deps({ log: message => { logged.push(message); } }), 'o/r#1');
    expect(logged.some(line => line.includes('could not read'))).toBe(true);
    expect(prepared).toEqual([]);
  });
});

describe('a posted review', () => {
  /** The tick that follows a review reaching GitHub: the mark is there and the search has dropped it. */
  async function postAndPoll(at = '2026-09-02T12:30:00.000Z', event: 'APPROVE' | 'COMMENT' = 'APPROVE'): Promise<void> {
    store.recordHandled({ prId: 'o/r#1', headSha: 'aaa', event, reviewUrl: 'https://github.com/o/r/pull/1#pullrequestreview-9', at });
    forge.requested = [];
    await runTick(store, deps());
  }

  it('keeps the pull request listed, reclaims its worktree once, and follows its head', async () => {
    forge.set(snapshot());
    await runTick(store, deps());
    expect(store.get('o/r#1')!.worktreePath).toBe('/wt/1');

    await postAndPoll();
    let pr = store.get('o/r#1')!;
    expect(pr.status).toBe('handled');
    expect(pr.statusReason).toBe('you approved');
    expect(removed).toEqual(['/wt/1']);
    expect(pr.worktreePath).toBeNull();

    // The author pushes: still handled, and the row says the review is behind the head.
    removed = [];
    prepared = [];
    forge.snapshots.set('o/r#1', snapshot({ headSha: 'bbb' }));
    await runTick(store, deps());
    pr = store.get('o/r#1')!;
    expect(pr.status).toBe('handled');
    expect(pr.statusReason).toBe('new commits since you approved');
    expect(removed).toEqual([]);
    expect(prepared).toEqual([]);
  });

  it('lists it under handled rather than ready or other', async () => {
    forge.set(snapshot());
    await runTick(store, deps());
    await postAndPoll();

    const view = buildView(store, 'http://localhost:5390', '2026-09-02T12:00:00.000Z');
    expect(view.handled.map(row => row.id)).toEqual(['o/r#1']);
    expect(view.ready).toEqual([]);
    expect(view.other).toEqual([]);
  });

  it('retires it once the pull request is merged', async () => {
    forge.set(snapshot());
    await runTick(store, deps());
    await postAndPoll();

    forge.snapshots.set('o/r#1', snapshot({ state: 'MERGED' }));
    await runTick(store, deps());
    expect(store.get('o/r#1')!.status).toBe('done');
    expect(buildView(store, 'http://localhost:5390', '2026-09-02T12:00:00.000Z').handled).toEqual([]);
  });

  it('goes back in the queue when the author asks for the review again', async () => {
    forge.set(snapshot());
    await runTick(store, deps());
    await postAndPoll();

    prepared = [];
    forge.requested = [{ owner: 'o', repo: 'r', number: 1 }];
    forge.snapshots.set('o/r#1', snapshot({ headSha: 'bbb' }));
    await runTick(store, deps());

    expect(prepared).toEqual(['o/r#1']);
    expect(store.get('o/r#1')!.status).toBe('prepared');
  });

  it('keeps a bumped preparation on a handled row, until that review is posted too', async () => {
    forge.set(snapshot());
    await runTick(store, deps());
    await postAndPoll();
    expect(store.get('o/r#1')!.status).toBe('handled');

    store.bump('o/r#1', '2026-09-02T13:00:00.000Z');
    prepared = [];
    prepareResult = snap => ({
      kind: 'prepared', headSha: snap.headSha, bundlePath: '/b/1.json', worktree: '/wt/1',
      logPath: '/l/1.log', at: '2026-09-02T13:05:00.000Z', summary: '1 P2', alert: null,
      alertFindings: [], posted: null, run: run(), validation: 'not-needed', validateRun: null,
    });
    await prepareBumped(store, deps(), 'o/r#1');
    expect(prepared).toEqual(['o/r#1']);
    expect(store.get('o/r#1')!.status).toBe('prepared');

    // The poll that follows leaves the fresh review where the reviewer can open it.
    await runTick(store, deps());
    expect(store.get('o/r#1')!.status).toBe('prepared');
    expect(buildView(store, 'http://localhost:5390', '2026-09-02T12:00:00.000Z').ready.map(row => row.id)).toEqual(['o/r#1']);

    // Posting that one settles the row again.
    await postAndPoll('2026-09-02T13:30:00.000Z', 'COMMENT');
    expect(store.get('o/r#1')!.status).toBe('handled');
    expect(store.get('o/r#1')!.statusReason).toBe('you commented');
  });

  it('adopts a pull request the inbox never polled, asking about it once', async () => {
    store.recordHandled({ prId: 'o/r#7', headSha: 'ggg', event: 'COMMENT', reviewUrl: null, at: '2026-09-02T11:00:00.000Z' });
    forge.set(snapshot({ number: 7, headSha: 'ggg' }), false);

    await runTick(store, deps());
    const pr = store.get('o/r#7')!;
    expect(pr.status).toBe('handled');
    expect(pr.statusReason).toBe('you commented');
    expect(prepared).toEqual([]);
    expect(forge.views).toEqual(['o/r#7']);

    // From here it is an ordinary row: the loop over what the search dropped keeps it current.
    forge.views = [];
    forge.snapshots.set('o/r#7', snapshot({ number: 7, headSha: 'hhh' }));
    await runTick(store, deps());
    expect(forge.views).toEqual(['o/r#7']);
    expect(store.get('o/r#7')!.statusReason).toBe('new commits since you commented');
  });

  it('takes a review posted after the request had already been withdrawn', async () => {
    forge.set(snapshot());
    await runTick(store, deps());

    // The request goes away with no review posted: the row is retired and its worktree freed.
    forge.requested = [];
    await runTick(store, deps());
    expect(store.get('o/r#1')!.status).toBe('hidden');
    expect(store.get('o/r#1')!.worktreePath).toBeNull();

    // The reviewer posts from their own clone afterwards.
    prepared = [];
    removed = [];
    store.recordHandled({ prId: 'o/r#1', headSha: 'aaa', event: 'APPROVE', reviewUrl: null, at: '2026-09-02T13:00:00.000Z' });
    await runTick(store, deps());

    const pr = store.get('o/r#1')!;
    expect(pr.status).toBe('handled');
    expect(pr.statusReason).toBe('you approved');
    expect(pr.worktreePath).toBeNull();
    expect(prepared).toEqual([]);
    expect(removed).toEqual([]);
    expect(buildView(store, 'http://localhost:5390', '2026-09-02T12:00:00.000Z').handled.map(row => row.id))
      .toEqual(['o/r#1']);
  });

  it('leaves a bumped preparation that failed on a handled row saying so', async () => {
    forge.set(snapshot());
    await runTick(store, deps());
    await postAndPoll();

    store.bump('o/r#1', '2026-09-02T13:00:00.000Z');
    prepareResult = () => ({
      kind: 'failed', failure: 'timeout', reason: 'the agent timed out',
      worktree: null, logPath: '/l/1.log', run: run(),
    });
    await prepareBumped(store, deps(), 'o/r#1');
    expect(store.get('o/r#1')!.status).toBe('failed');

    await runTick(store, deps());
    let pr = store.get('o/r#1')!;
    expect(pr.status).toBe('failed');
    expect(pr.statusReason).toBe('the agent timed out');

    // The next push is a new change, and the row goes back to what the posted review said about it.
    forge.snapshots.set('o/r#1', snapshot({ headSha: 'bbb' }));
    await runTick(store, deps());
    pr = store.get('o/r#1')!;
    expect(pr.status).toBe('handled');
    expect(pr.statusReason).toBe('new commits since you approved');
  });

  it('retires an adopted pull request that has since been merged, and asks no more', async () => {
    store.recordHandled({ prId: 'o/r#8', headSha: 'ggg', event: 'APPROVE', reviewUrl: null, at: '2026-09-02T11:00:00.000Z' });
    forge.set(snapshot({ number: 8, state: 'MERGED' }), false);

    await runTick(store, deps());
    expect(store.get('o/r#8')!.status).toBe('done');

    forge.views = [];
    await runTick(store, deps());
    expect(forge.views).toEqual([]);
  });

  it('leaves a mark the forge knows nothing about alone', async () => {
    store.recordHandled({ prId: 'o/r#9', headSha: 'ggg', event: 'APPROVE', reviewUrl: null, at: '2026-09-02T11:00:00.000Z' });
    store.recordHandled({ prId: 'not-a-pull-request', headSha: 'ggg', event: 'APPROVE', reviewUrl: null, at: '2026-09-02T11:00:00.000Z' });

    await runTick(store, deps());

    expect(store.get('o/r#9')).toBeNull();
    expect(forge.views).toEqual(['o/r#9']);
  });
});

describe('a pull request the daemon posted the alert findings to', () => {
  const POSTED_AT = '2026-09-02T12:00:00.000Z';
  const REVIEW = 'https://github.com/o/r/pull/1#pullrequestreview-9';

  /** A review prepared with an alert, and the findings behind it posted at that head. */
  function alerting(): void {
    prepareResult = snap => ({
      kind: 'prepared', headSha: snap.headSha, bundlePath: `/b/${snap.number}.json`,
      worktree: `/wt/${snap.number}`, logPath: `/l/${snap.number}.log`, at: POSTED_AT,
      summary: '1 P1', alert: 'touches auth', alertFindings: ['cf15e689'],
      posted: { at: POSTED_AT, headSha: snap.headSha, url: REVIEW, commentIds: 1 },
      run: run(), validation: 'not-needed', validateRun: null,
    });
  }

  it('records the review against the row, so the next head is the only one posted to again', async () => {
    alerting();
    forge.set(snapshot());
    await runTick(store, deps());

    expect(store.get('o/r#1')!.autoPosted).toEqual({ at: POSTED_AT, headSha: 'aaa', url: REVIEW });
  });

  it('tells the next preparation which head has already been posted to', async () => {
    alerting();
    forge.set(snapshot());
    const heads: (string | null)[] = [];
    const record = (over = {}) => deps({
      prepare: (snap, opts) => { heads.push(opts.alreadyPostedHead); return Promise.resolve(prepareResult(snap)); },
      ...over,
    });
    await runTick(store, record());

    // The next push is a head nobody has posted to, so the refreshed review posts again.
    forge.snapshots.set('o/r#1', snapshot({ headSha: 'bbb' }));
    await runTick(store, record());

    expect(heads).toEqual([null, 'aaa']);
    expect(store.get('o/r#1')!.autoPosted!.headSha).toBe('bbb');
  });

  it('stays the reviewer\'s to review once the post has withdrawn the request', async () => {
    alerting();
    forge.set(snapshot());
    await runTick(store, deps());

    // GitHub drops it from review-requested:@me the moment the review lands.
    forge.requested = [];
    await runTick(store, deps());

    const pr = store.get('o/r#1')!;
    expect(pr.status).toBe('prepared');
    expect(pr.worktreePath).toBe('/wt/1');
    expect(removed).toEqual([]);
    const view = buildView(store, 'http://localhost:5390', POSTED_AT);
    expect(view.alerted.map(row => row.id)).toEqual(['o/r#1']);
    expect(view.alerted[0].autoPosted).toEqual({ at: POSTED_AT, headSha: 'aaa', url: REVIEW });
  });

  it('re-prepares and posts again when the author pushes, without losing the worktree', async () => {
    alerting();
    forge.set(snapshot());
    await runTick(store, deps());

    forge.requested = [];
    forge.snapshots.set('o/r#1', snapshot({ headSha: 'bbb' }));
    prepared = [];
    await runTick(store, deps());

    expect(prepared).toEqual(['o/r#1']);
    expect(store.get('o/r#1')!.preparedHeadSha).toBe('bbb');
    expect(store.get('o/r#1')!.autoPosted!.headSha).toBe('bbb');
    expect(removed).toEqual([]);
  });

  it('holds at its head once the reviewer has dismissed it', async () => {
    alerting();
    forge.set(snapshot());
    await runTick(store, deps());
    store.setStatus('o/r#1', 'dismissed', 'dismissed by the reviewer');

    forge.requested = [];
    prepared = [];
    await runTick(store, deps());

    expect(store.get('o/r#1')!.status).toBe('dismissed');
    expect(prepared).toEqual([]);
  });

  it('becomes handled, and gives up its worktree, once the reviewer posts their own review', async () => {
    alerting();
    forge.set(snapshot());
    await runTick(store, deps());

    store.recordHandled({ prId: 'o/r#1', headSha: 'aaa', event: 'APPROVE', reviewUrl: REVIEW, at: '2026-09-02T12:30:00.000Z' });
    forge.requested = [];
    await runTick(store, deps());

    const pr = store.get('o/r#1')!;
    expect(pr.status).toBe('handled');
    expect(pr.statusReason).toBe('you approved');
    expect(removed).toEqual(['/wt/1']);
    expect(pr.worktreePath).toBeNull();
  });

  it('is retired like any other once it is merged', async () => {
    alerting();
    forge.set(snapshot());
    await runTick(store, deps());

    forge.requested = [];
    forge.snapshots.set('o/r#1', snapshot({ state: 'MERGED' }));
    await runTick(store, deps());

    expect(store.get('o/r#1')!.status).toBe('done');
    expect(removed).toEqual(['/wt/1']);
  });

  it('waits for CI like a requested row when its refresh is held back', async () => {
    alerting();
    forge.set(snapshot());
    await runTick(store, deps());

    forge.requested = [];
    forge.snapshots.set('o/r#1', snapshot({ headSha: 'bbb', checks: [{ name: 'build', status: 'pending' }] }));
    prepared = [];
    await runTick(store, deps({ waitForCi: true }));

    expect(prepared).toEqual([]);
    expect(store.get('o/r#1')!.statusReason).toBe('waiting: CI running (1 checks)');
    expect(removed).toEqual([]);
  });
});
