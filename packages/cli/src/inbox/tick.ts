import type { PrRef, PrSnapshot } from '@diffity/github';
import { reconcile } from './reconcile.js';
import { isRetired, prId, runRecordOf, type InboxPr, type InboxStore, type RunOutcome } from './store.js';
import type { PrepareResult } from './prepare.js';

/** The forge, as one tick needs it — one interface so a test can stand in for GitHub. */
export interface Forge {
  viewerLogin(): Promise<string | null>;
  searchReviewRequested(): Promise<PrRef[]>;
  viewPr(ref: PrRef): Promise<PrSnapshot | null>;
}

export interface TickDeps {
  forge: Forge;
  /** Prepares one pull request; the daemon passes the real preparer, a test a fake. */
  prepare(snapshot: PrSnapshot, opts: { bumped: boolean }): Promise<PrepareResult>;
  removeWorktree(worktree: string, repo: string): void | Promise<void>;
  log(message: string): void;
  now(): string;
  /** False once the daemon is shutting down, so the drain stops starting new preparations. */
  shouldContinue?(): boolean;
  /** How many prepared reviews may wait for the reviewer at once; the rest of the queue waits. */
  maxPrepared: number;
  /** `agent.model`, recorded for a run that did not report which models it spent on. */
  agentModel: string | null;
  /** Holds preparation back until then — a session limit is waited out, not retried. */
  pauseUntil(until: string): void;
  /** True while preparation is held back; polling and reconciling carry on regardless. */
  paused?(): boolean;
}

/**
 * One poll of the forge turned into inbox state: every requested pull request is observed and
 * reconciled, every pull request the inbox already knew but the search no longer lists is retired,
 * and everything the reconcile marked for preparation is prepared, one at a time.
 */
export async function runTick(store: InboxStore, deps: TickDeps): Promise<void> {
  const viewerLogin = await deps.forge.viewerLogin();
  const requested = await deps.forge.searchReviewRequested();
  const requestedIds = new Set(requested.map(prId));

  const toPrepare: PrSnapshot[] = [];

  for (const ref of requested) {
    const snapshot = await deps.forge.viewPr(ref);
    if (!snapshot) {
      deps.log(`could not read ${prId(ref)} this tick; leaving it as it was`);
      continue;
    }
    const existing = store.get(prId(ref));
    const pr = store.observe(snapshot, true, deps.now());
    const transition = reconcile({ existing, snapshot, requested: true, viewerLogin });
    if (transition) {
      store.setStatus(pr.id, transition.status, transition.reason);
      if (transition.prepare) {
        toPrepare.push(snapshot);
      }
    }
  }

  // Rows the search no longer returns: retired against their latest detail, and their worktrees
  // reclaimed. A closed pull request may not be searchable at all, so it is asked about directly.
  for (const pr of store.all()) {
    if (requestedIds.has(pr.id) || isRetired(pr.status)) {
      continue;
    }
    const snapshot = await deps.forge.viewPr(prToRef(pr));
    if (!snapshot) {
      continue;
    }
    store.observe(snapshot, false, deps.now());
    const transition = reconcile({ existing: pr, snapshot, requested: false, viewerLogin });
    if (transition) {
      store.setStatus(pr.id, transition.status, transition.reason);
      if (pr.worktreePath) {
        await deps.removeWorktree(pr.worktreePath, pr.repo);
        store.setPaths(pr.id, { worktreePath: null });
      }
    }
  }

  // A pause is the reviewer's Claude limit, not the forge's: the poll above still ran, so the page
  // is current, and only the agent runs wait.
  if (deps.paused?.()) {
    if (toPrepare.length > 0) {
      deps.log(`${toPrepare.length} left queued: preparing is paused`);
    }
    return;
  }

  // Bumped ones first, in the order they were asked for, and past the cap: the reviewer wants them
  // now. A stale review is already in the reviewer's pile and is only refreshed. New ones fill the
  // pile smallest first and no further than `maxPrepared`: each preparation spends an agent run, so
  // the rest stay queued until a prepared review is posted or dismissed.
  const candidates = toPrepare
    .map(snapshot => {
      const row = store.get(prId(snapshot));
      return { snapshot, refresh: row?.status === 'stale', bumpedAt: row?.bumpedAt ?? null };
    })
    .sort((a, b) => Number(b.bumpedAt !== null) - Number(a.bumpedAt !== null)
      || (a.bumpedAt ?? '').localeCompare(b.bumpedAt ?? '')
      || Number(b.refresh) - Number(a.refresh)
      || diffSize(a.snapshot) - diffSize(b.snapshot));
  let waiting = 0;
  for (const { snapshot, refresh } of candidates) {
    if (deps.shouldContinue && !deps.shouldContinue()) {
      break;
    }
    // Read again, not taken from the listing: the reviewer may have dismissed or bumped it from
    // the page while this tick was busy with another.
    const row = store.get(prId(snapshot));
    if (row?.status === 'dismissed') {
      continue;
    }
    const bumped = row?.bumpedAt != null;
    if (!refresh && !bumped && countReady(store) >= deps.maxPrepared) {
      store.setStatus(prId(snapshot), 'queued', `waiting: ${deps.maxPrepared} reviews already prepared`);
      waiting++;
      continue;
    }
    await prepareOne(store, snapshot, deps, bumped);
  }
  if (waiting > 0) {
    deps.log(`${waiting} left queued: ${deps.maxPrepared} reviews already prepared`);
  }
}

/** Prepared reviews waiting for the reviewer, stale ones included: they are still openable. */
function countReady(store: InboxStore): number {
  return store.all().filter(pr => pr.status === 'prepared' || pr.status === 'stale').length;
}

function diffSize(snapshot: PrSnapshot): number {
  return snapshot.additions + snapshot.deletions;
}

async function prepareOne(store: InboxStore, snapshot: PrSnapshot, deps: TickDeps, bumped: boolean): Promise<void> {
  const id = prId(snapshot);
  store.setStatus(id, 'preparing', null);
  deps.log(`preparing ${id} — ${snapshot.title}`);

  const result = await deps.prepare(snapshot, { bumped });
  store.clearBump(id);
  recordPrepareRun(store, snapshot, deps, result);
  switch (result.kind) {
    case 'prepared':
      store.markPrepared(id, {
        headSha: result.headSha,
        bundlePath: result.bundlePath,
        worktreePath: result.worktree,
        logPath: result.logPath,
        at: result.at,
        summary: result.summary,
        alert: result.alert,
      });
      deps.log(`prepared ${id}`);
      return;
    case 'skipped':
      store.setStatus(id, 'skipped', result.reason);
      store.setPaths(id, { worktreePath: null, logPath: result.logPath });
      deps.log(`skipped ${id}: ${result.reason}`);
      return;
    case 'failed':
      if (result.failure === 'rate-limit') {
        // Nothing is wrong with this pull request, so it keeps its retries and goes back in the
        // queue; nothing else is prepared until the limit lifts either.
        store.setStatus(id, 'queued', result.reason);
        store.setPaths(id, { worktreePath: null, logPath: result.logPath ?? null });
        deps.pauseUntil(result.resetsAt ?? new Date(Date.parse(deps.now()) + 30 * 60_000).toISOString());
        deps.log(`${id}: ${result.reason}`);
        return;
      }
      store.failAttempt(id, result.reason);
      store.setPaths(id, { worktreePath: result.worktree ?? null, logPath: result.logPath ?? null });
      deps.log(`failed to prepare ${id}: ${result.reason}`);
      return;
  }
}

/** The preparation's agent run in the log — unless it never got as far as running one. */
function recordPrepareRun(store: InboxStore, snapshot: PrSnapshot, deps: TickDeps, result: PrepareResult): void {
  if (result.kind === 'failed' && result.failure === 'worktree') {
    return;
  }
  store.recordRun(runRecordOf({
    prId: prId(snapshot),
    headSha: result.kind === 'prepared' ? result.headSha : snapshot.headSha,
    phase: 'prepare',
    outcome: outcomeOf(result),
    startedAt: result.run.startedAt,
    endedAt: result.run.endedAt,
    stats: result.run.stats,
    configModel: deps.agentModel,
    note: result.kind === 'prepared' ? null : result.reason,
  }));
}

function outcomeOf(result: PrepareResult): RunOutcome {
  switch (result.kind) {
    case 'prepared':
      return 'prepared';
    case 'skipped':
      return 'skipped';
    case 'failed':
      if (result.failure === 'timeout') return 'timeout';
      if (result.failure === 'rate-limit') return 'rate-limited';
      return 'failed';
  }
}

function prToRef(pr: InboxPr): PrRef {
  return { owner: pr.owner, repo: pr.repo, number: pr.number };
}
