import type { PrRef, PrSnapshot } from '@diffity/github';
import { alertForPaths } from './paths-alert.js';
import { reconcile } from './reconcile.js';
import { isRetired, prId, prIdToRef, runRecordOf, type InboxPr, type InboxStore, type RunOutcome } from './store.js';
import { localHhMm } from './runs.js';
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
  /**
   * The pull requests a preparation is running for right now, the daemon's own set: a bump prepares
   * beside the tick, so both have to see the same ones.
   */
  inFlight: Set<string>;
  /** How many prepared reviews may wait for the reviewer at once; the rest of the queue waits. */
  maxPrepared: number;
  /** Whether a pull request waits for its CI to pass before an agent is spent on it. */
  waitForCi: boolean;
  /** The title patterns that skip a pull request before an agent is spent on it. */
  skipTitles: string[];
  /** The changed paths that make a review worth the reviewer's attention now. */
  alertPaths: string[];
  /** `agent.model`, recorded for a run that did not report which models it spent on. */
  agentModel: string | null;
  /** `validate.model`, recorded the same way for the pass that checks the draft. */
  validateModel: string | null;
  /** Holds preparation back until then — a session limit is waited out, not retried. */
  pauseUntil(until: string): void;
  /** Until when preparation is held back, or null when it is not; polling carries on regardless. */
  pausedUntil?(): string | null;
}

/**
 * One poll of the forge turned into inbox state: every requested pull request is observed and
 * reconciled, every pull request the inbox already knew but the search no longer lists is retired
 * or listed as handled, every pull request handled from elsewhere is adopted, and everything the
 * reconcile marked for preparation is prepared, one at a time.
 */
export async function runTick(store: InboxStore, deps: TickDeps): Promise<void> {
  const viewerLogin = await deps.forge.viewerLogin();
  const requested = await deps.forge.searchReviewRequested();
  const requestedIds = new Set(requested.map(prId));

  const toPrepare: PrSnapshot[] = [];

  for (const ref of requested) {
    // A preparation running for this one — the tick's own, or a bump's — owns the row until it
    // ends: reconciling it now would re-queue a `preparing` row and hand it a second agent.
    if (deps.inFlight.has(prId(ref))) {
      continue;
    }
    const snapshot = await deps.forge.viewPr(ref);
    if (!snapshot) {
      deps.log(`could not read ${prId(ref)} this tick; leaving it as it was`);
      continue;
    }
    const existing = store.get(prId(ref));
    const pr = store.observe(snapshot, true, deps.now());
    const transition = reconcile({
      existing, snapshot, requested: true, viewerLogin, handled: store.latestHandled(pr.id),
      waitForCi: deps.waitForCi, skipTitles: deps.skipTitles,
    });
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
    if (requestedIds.has(pr.id) || isRetired(pr.status) || deps.inFlight.has(pr.id)) {
      continue;
    }
    const snapshot = await deps.forge.viewPr(prToRef(pr));
    if (!snapshot) {
      continue;
    }
    store.observe(snapshot, false, deps.now());
    const transition = reconcile({ existing: pr, snapshot, requested: false, viewerLogin, handled: store.latestHandled(pr.id) });
    if (transition) {
      store.setStatus(pr.id, transition.status, transition.reason);
      if (pr.worktreePath) {
        await deps.removeWorktree(pr.worktreePath, pr.repo);
        store.setPaths(pr.id, { worktreePath: null });
      }
    }
  }

  // A review posted from a checkout the inbox never polled — the reviewer's own clone — leaves
  // nothing behind but its mark. Each such pull request is asked about once: observing it gives it
  // a row, and the loop above takes it over from the next tick.
  for (const id of store.handledIds()) {
    if (requestedIds.has(id) || deps.inFlight.has(id) || store.get(id)) {
      continue;
    }
    const ref = prIdToRef(id);
    if (!ref) {
      continue;
    }
    const snapshot = await deps.forge.viewPr(ref);
    if (!snapshot) {
      continue;
    }
    store.observe(snapshot, false, deps.now());
    const transition = reconcile({ existing: null, snapshot, requested: false, viewerLogin, handled: store.latestHandled(id) });
    if (transition) {
      store.setStatus(id, transition.status, transition.reason);
    }
  }

  // A pause is the reviewer's Claude limit, not the forge's: the poll above still ran, so the page
  // is current, and only the agent runs wait. The reason goes back on every row held back, because
  // the reconcile above has just cleared it — a queued row reads as plainly queued otherwise.
  const pausedUntil = deps.pausedUntil?.() ?? null;
  if (pausedUntil) {
    const reason = `waiting: preparing paused until ${localHhMm(pausedUntil)}`;
    for (const snapshot of toPrepare) {
      store.setStatus(prId(snapshot), 'queued', reason);
    }
    if (toPrepare.length > 0) {
      deps.log(`${toPrepare.length} left queued: ${reason}`);
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
    // Read again, not taken from the listing: the reviewer may have dismissed it, or bumped it and
    // had it prepared beside this tick, while the tick was busy with another.
    const row = store.get(prId(snapshot));
    if (row?.status === 'dismissed' || deps.inFlight.has(prId(snapshot))) {
      continue;
    }
    if (row?.status === 'prepared' && row.preparedHeadSha === snapshot.headSha) {
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

/**
 * The one pull request the reviewer asked for by name, prepared now — beside whatever the tick is
 * already preparing rather than after it, because a preparation is minutes of agent and the ↑ means
 * now. There is no poll behind it: the row is read from the forge on its own and put through the
 * same reconcile, so a draft, or one merged since it was queued, is still not handed an agent.
 */
export async function prepareBumped(store: InboxStore, deps: TickDeps, id: string): Promise<void> {
  const existing = store.get(id);
  if (!existing) {
    deps.log(`cannot prepare ${id}: the inbox has no such pull request`);
    return;
  }
  if (deps.inFlight.has(id)) {
    return;
  }
  const snapshot = await deps.forge.viewPr(prToRef(existing));
  if (!snapshot) {
    deps.log(`could not read ${id} to prepare it; leaving it as it was`);
    return;
  }
  const viewerLogin = await deps.forge.viewerLogin();
  store.observe(snapshot, true, deps.now());
  // Whether the review is still wanted is taken from the state, not assumed: no search ran, and one
  // merged or closed while it waited is retired rather than reviewed.
  const transition = reconcile({
    existing, snapshot, requested: snapshot.state === 'OPEN', viewerLogin,
    handled: store.latestHandled(id),
    waitForCi: deps.waitForCi, skipTitles: deps.skipTitles,
  });
  if (transition) {
    store.setStatus(id, transition.status, transition.reason);
  }
  if (!transition?.prepare) {
    return;
  }
  const pausedUntil = deps.pausedUntil?.() ?? null;
  if (pausedUntil) {
    const reason = `waiting: preparing paused until ${localHhMm(pausedUntil)}`;
    store.setStatus(id, 'queued', reason);
    deps.log(`${id} left queued: ${reason}`);
    return;
  }
  await prepareOne(store, snapshot, deps, true);
}

async function prepareOne(store: InboxStore, snapshot: PrSnapshot, deps: TickDeps, bumped: boolean): Promise<void> {
  const id = prId(snapshot);
  // Claimed in the same breath as it is checked: a bump and a tick can reach the same pull request
  // at once, and two agents must not end up in one worktree.
  if (deps.inFlight.has(id)) {
    return;
  }
  deps.inFlight.add(id);
  store.setStatus(id, 'preparing', null);
  deps.log(`preparing ${id} — ${snapshot.title}`);

  let result: PrepareResult;
  try {
    result = await deps.prepare(snapshot, { bumped });
  } finally {
    deps.inFlight.delete(id);
  }
  store.clearBump(id);
  recordPrepareRun(store, snapshot, deps, result);
  recordValidateRun(store, snapshot, deps, result);
  switch (result.kind) {
    case 'prepared':
      store.markPrepared(id, {
        headSha: result.headSha,
        bundlePath: result.bundlePath,
        worktreePath: result.worktree,
        logPath: result.logPath,
        at: result.at,
        summary: result.summary,
        // The agent's judgement first; the reviewer's own paths stand in when it raised nothing.
        alert: result.alert ?? alertForPaths(snapshot.files, deps.alertPaths),
      });
      deps.log(`prepared ${id}`);
      if (result.validateRun?.note) {
        deps.log(`${id}: the drafted findings went unchecked — ${result.validateRun.note}`);
      }
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

/** The pass that checked the draft, when there was one; the draft stands whatever it came to. */
function recordValidateRun(store: InboxStore, snapshot: PrSnapshot, deps: TickDeps, result: PrepareResult): void {
  if (result.kind !== 'prepared' || result.validateRun === null) {
    return;
  }
  const { startedAt, endedAt, stats, outcome, note } = result.validateRun;
  store.recordRun(runRecordOf({
    prId: prId(snapshot),
    headSha: result.headSha,
    phase: 'validate',
    outcome,
    startedAt,
    endedAt,
    stats,
    configModel: deps.validateModel,
    note,
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
