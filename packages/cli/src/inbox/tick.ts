import type { PrRef, PrSnapshot, TriageCandidate } from '@diffity/github';
import { alertForPaths } from './paths-alert.js';
import { reconcile } from './reconcile.js';
import { isRetired, prId, prIdToRef, runRecordOf, type Handled, type InboxPr, type InboxStore, type RunOutcome, type TriageRecord } from './store.js';
import { localHhMm } from './runs.js';
import type { PrepareResult, RunLog } from './prepare.js';
import type { TriageConfig } from './config.js';
import { bodyRuleReason, candidateSkipReason, triageStatusReason } from './triage.js';

/** The forge, as one tick needs it — one interface so a test can stand in for GitHub. */
export interface Forge {
  viewerLogin(): Promise<string | null>;
  searchReviewRequested(): Promise<PrRef[]>;
  viewPr(ref: PrRef): Promise<PrSnapshot | null>;
  /** Every open, non-draft pull request of a watched repository, description and all. */
  listOpenPrs(repo: string): Promise<TriageCandidate[]>;
  /** The pull request's diff, for the model that triages what the rules missed. */
  prDiff(ref: PrRef): Promise<string>;
}

/** What one preparation is told about the pull request beyond its snapshot. */
export interface PrepareRequest {
  /** The reviewer asked for this one by name, so the filter does not get a say. */
  bumped: boolean;
  /** The head the alert findings have already been posted for, so no head is posted to twice. */
  alreadyPostedHead: string | null;
  /** Why the triage flagged it, when it did: a reason for an alert on its own. */
  triageReason: string | null;
  /** The reviewer, so their own comments on the pull request can be recognised as theirs. */
  viewerLogin: string | null;
  /** The head the reviewer has reviewed themselves, which is never posted to automatically. */
  reviewedHead: string | null;
}

/** What the triage model is given: the pull request, its diff, and what the reviewer cares about. */
export interface TriageAgentInput {
  snapshot: PrSnapshot;
  diff: string;
  alertWhen: string;
}

/** The triage run as the log wants it, whatever the model came to. */
export interface TriageAgentRun extends RunLog {
  outcome: RunOutcome;
  /** Why there is no verdict, when there is none. */
  note: string | null;
}

export interface TriageAgentResult {
  /** Why the pull request needs the reviewer, or null when the model saw no reason. */
  reason: string | null;
  run: TriageAgentRun;
}

export interface TickDeps {
  forge: Forge;
  /** Prepares one pull request; the daemon passes the real preparer, a test a fake. */
  prepare(snapshot: PrSnapshot, opts: PrepareRequest): Promise<PrepareResult>;
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
  /** The reviewer's own words on what needs them now, which the triage model judges against. */
  alertWhen: string;
  /** Which repositories are watched, and how a watched pull request is judged. */
  triage: TriageConfig;
  /** The cheap look at one watched pull request, when a model is named for it. */
  triageAgent(input: TriageAgentInput): Promise<TriageAgentResult>;
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
      // The rules that cost nothing apply to what the reviewer was asked for too: a hit puts the
      // row ahead of the ordinary queue and gives its preparing agent a reason of its own.
      const flagged = transition.prepare ? freeRuleReason(pr, snapshot, deps) : null;
      if (flagged) {
        store.setTriageReason(pr.id, flagged);
      }
      store.setStatus(pr.id, transition.status, flagged ? triageStatusReason(flagged) : transition.reason);
      if (transition.prepare) {
        toPrepare.push(snapshot);
      }
    }
  }

  // The watched repositories, before the loop below has anything to say about the rows this adds.
  const triaged = await runTriagePass(store, deps, { requestedIds, viewerLogin, toPrepare });

  // Rows the search no longer returns: retired against their latest detail, and their worktrees
  // reclaimed. A closed pull request may not be searchable at all, so it is asked about directly.
  // One the daemon posted the alert findings to itself is the exception: that post is what
  // withdrew the review request, so the pull request is still the reviewer's to review and is
  // reconciled as though the search had listed it.
  for (const pr of store.all()) {
    // A row the triage queued moments ago has just been read and decided; reconciling it again
    // would only spend another call and write over the reason it was queued with.
    if (requestedIds.has(pr.id) || triaged.has(pr.id) || isRetired(pr.status) || deps.inFlight.has(pr.id)) {
      continue;
    }
    const snapshot = await deps.forge.viewPr(prToRef(pr));
    if (!snapshot) {
      continue;
    }
    const handled = store.latestHandled(pr.id);
    const requested = stillTheReviewers(pr, handled, takenInAt(store, pr.id)) && snapshot.state === 'OPEN';
    store.observe(snapshot, requested, deps.now());
    // The CI hold and the title patterns matter only where a preparation could follow, which is
    // the row still asking for the reviewer.
    const transition = reconcile({
      existing: pr, snapshot, requested, viewerLogin, handled,
      waitForCi: deps.waitForCi, skipTitles: deps.skipTitles,
    });
    if (transition) {
      store.setStatus(pr.id, transition.status, transition.reason);
      if (transition.prepare) {
        toPrepare.push(snapshot);
      }
      // The worktree goes only when nothing will be opened from it again: a row that stays
      // openable, or is about to be prepared afresh, needs the checkout it has.
      if (pr.worktreePath && (isRetired(transition.status) || transition.status === 'handled')) {
        await deps.removeWorktree(pr.worktreePath, pr.repo);
        store.setPaths(pr.id, { worktreePath: null });
      }
    }
  }

  // A review posted from a checkout the inbox never polled — the reviewer's own clone — leaves
  // nothing behind but its mark, and a row the loop above no longer looks at (retired as `hidden`
  // before the review was posted) is in the same position. Each is asked about once: the row it
  // gets is listed, so the loop above has it from the next tick.
  for (const id of store.unadoptedHandledIds()) {
    if (requestedIds.has(id) || triaged.has(id) || deps.inFlight.has(id)) {
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
    const existing = store.get(id);
    store.observe(snapshot, false, deps.now());
    const transition = reconcile({ existing, snapshot, requested: false, viewerLogin, handled: store.latestHandled(id) });
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
  // now. A flagged one comes next — their own rules say it needs them. A stale review is already in
  // the reviewer's pile and is only refreshed. New ones fill the pile smallest first and no further
  // than `maxPrepared`: each preparation spends an agent run, so the rest stay queued until a
  // prepared review is posted or dismissed.
  const candidates = toPrepare
    .map(snapshot => {
      const row = store.get(prId(snapshot));
      return { snapshot, refresh: row?.status === 'stale', bumpedAt: row?.bumpedAt ?? null, flagged: row?.triageReason != null };
    })
    .sort((a, b) => Number(b.bumpedAt !== null) - Number(a.bumpedAt !== null)
      || (a.bumpedAt ?? '').localeCompare(b.bumpedAt ?? '')
      || Number(b.flagged) - Number(a.flagged)
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
    // One the triage took in was never asked of the reviewer, so the auto-prepare count — which
    // paces the reviews they did ask for — is not what should hold it back. A flagged pull request
    // in their own inbox jumps the queue but still waits its turn for the pile to clear.
    const takenIn = row?.triageReason != null && row.requested === false;
    if (!refresh && !bumped && !takenIn && countReady(store) >= deps.maxPrepared) {
      store.setStatus(prId(snapshot), 'queued', `waiting: ${deps.maxPrepared} reviews already prepared`);
      waiting++;
      continue;
    }
    await prepareOne(store, snapshot, deps, bumped, viewerLogin);
  }
  if (waiting > 0) {
    deps.log(`${waiting} left queued: ${deps.maxPrepared} reviews already prepared`);
  }
}

/** How long a look that reached no verdict stands before the next pass tries it again. */
const TRIAGE_RETRY_MS = 60 * 60_000;

/**
 * The quick look over every watched repository: each open pull request the inbox does not already
 * own is judged, cheaply first, and only a flagged one is taken into the inbox and prepared. A
 * decision is kept against the pull request's own last-updated stamp, so a pull request nothing has
 * changed about costs nothing at the next poll. Returns the ids this pass took in.
 */
async function runTriagePass(
  store: InboxStore,
  deps: TickDeps,
  ctx: { requestedIds: Set<string>; viewerLogin: string | null; toPrepare: PrSnapshot[] },
): Promise<Set<string>> {
  const flagged = new Set<string>();
  if (deps.triage.repos.length === 0) {
    return flagged;
  }
  let watched = 0;
  let quiet = 0;
  let deferred = 0;
  // A session limit is what holds every agent run back, the triage model's among them; the rules
  // still cost nothing, so they run and only the model step waits.
  const pausedUntil = deps.pausedUntil?.() ?? null;
  for (const repo of deps.triage.repos) {
    let candidates: TriageCandidate[];
    try {
      candidates = await deps.forge.listOpenPrs(repo);
    } catch (err) {
      deps.log(`could not list the open pull requests of ${repo}: ${err instanceof Error ? err.message : err}`);
      continue;
    }
    for (const candidate of candidates) {
      const id = prId(candidate);
      const row = store.get(id);
      // The inbox proper owns anything it was asked for and anything it has not finished with; the
      // triage is only for what nobody has put in front of the reviewer.
      if (ctx.requestedIds.has(id) || deps.inFlight.has(id) || (row !== null && !isRetired(row.status))) {
        continue;
      }
      watched++;
      const last = store.triageOf(id);
      const skip = candidateSkipReason(candidate, ctx.viewerLogin, deps.skipTitles);
      if (skip) {
        if (last?.updatedAt !== candidate.updatedAt) {
          store.recordTriage({ prId: id, updatedAt: candidate.updatedAt, headSha: null, outcome: 'skipped', reason: skip, at: deps.now() });
        }
        continue;
      }
      if (last && last.updatedAt === candidate.updatedAt && !worthAnotherLook(last, deps.now())) {
        // Decided already, and nothing about the pull request has moved since.
        if (last.outcome === 'none') {
          quiet++;
        }
        continue;
      }
      const decision = await triageOne(store, deps, candidate, last, pausedUntil !== null);
      if (decision.kind === 'unread') {
        // The detail view failed: nothing is recorded, so the next poll looks again.
        deps.log(`could not read ${id} to triage it; leaving it for the next poll`);
        continue;
      }
      if (decision.kind === 'deferred') {
        // Nothing recorded, so the pass after the pause is the one that decides this pull request.
        deferred++;
        continue;
      }
      if (decision.kind === 'failed') {
        // A look that reached no verdict is not the same as one that saw nothing: it is kept as
        // such, so the next pass tries it again rather than reading the pull request as quiet.
        store.recordTriage({ prId: id, updatedAt: candidate.updatedAt, headSha: null, outcome: 'failed', reason: decision.note, at: deps.now() });
        continue;
      }
      store.recordTriage({
        prId: id, updatedAt: candidate.updatedAt, headSha: decision.snapshot?.headSha ?? null,
        outcome: decision.reason === null ? 'none' : 'alert', reason: decision.reason, at: deps.now(),
      });
      if (decision.reason === null || decision.snapshot === null) {
        quiet++;
        continue;
      }
      store.observe(decision.snapshot, false, deps.now());
      store.setStatus(id, 'queued', triageStatusReason(decision.reason));
      store.setTriageReason(id, decision.reason);
      ctx.toPrepare.push(decision.snapshot);
      flagged.add(id);
      deps.log(`${id} flagged by triage: ${decision.reason}`);
    }
  }
  if (pausedUntil !== null && deferred > 0) {
    deps.log(`${deferred} watched pull request(s) left for the next pass: preparing paused until ${localHhMm(pausedUntil)}`);
  }
  store.recordTriagePass({ watched, quiet, at: deps.now() });
  return flagged;
}

/**
 * Whether a decision already made about this version of the pull request should be made again: one
 * that reached no verdict is worth another look after a while, and every other decision stands.
 */
function worthAnotherLook(last: TriageRecord, now: string): boolean {
  if (last.outcome !== 'failed') {
    return false;
  }
  const since = Date.parse(now) - Date.parse(last.at);
  return Number.isFinite(since) && since >= TRIAGE_RETRY_MS;
}

/**
 * What one pass made of one watched pull request: a decision to record, a look that reached no
 * verdict, a pull request the forge would not describe, or one left for a later pass because the
 * model it needed cannot run yet.
 */
type TriageDecision =
  | { kind: 'decided'; reason: string | null; snapshot: PrSnapshot | null }
  | { kind: 'failed'; note: string }
  | { kind: 'unread' }
  | { kind: 'deferred' };

/**
 * What this poll makes of one watched pull request: the body patterns cost nothing, the reviewer's
 * paths cost one detail view, and the model — when one is named and can run — costs a run, but only
 * on a head it has not seen.
 */
async function triageOne(
  store: InboxStore,
  deps: TickDeps,
  candidate: TriageCandidate,
  last: { headSha: string | null } | null,
  paused: boolean,
): Promise<TriageDecision> {
  const ref: PrRef = { owner: candidate.owner, repo: candidate.repo, number: candidate.number };
  let reason = bodyRuleReason(candidate.body, deps.triage.bodyPatterns);
  let snapshot: PrSnapshot | null = null;

  if (reason === null && deps.alertPaths.length > 0) {
    snapshot = await deps.forge.viewPr(ref);
    if (!snapshot) {
      return { kind: 'unread' };
    }
    reason = alertForPaths(snapshot.files, deps.alertPaths);
  }
  if (reason === null && deps.triage.model !== null) {
    if (paused) {
      return { kind: 'deferred' };
    }
    snapshot ??= await deps.forge.viewPr(ref);
    if (!snapshot) {
      return { kind: 'unread' };
    }
    // Only the discussion has moved since the last look, and the model reads the change, not the
    // discussion: there is nothing new for it to judge.
    if (last?.headSha === snapshot.headSha) {
      return { kind: 'decided', reason: null, snapshot };
    }
    const verdict = await askTheTriageModel(store, deps, snapshot);
    if (verdict.note !== null) {
      return { kind: 'failed', note: verdict.note };
    }
    reason = verdict.reason;
  }
  if (reason !== null) {
    // Read before anything is recorded, so a detail view that fails leaves the flag for next time.
    snapshot ??= await deps.forge.viewPr(ref);
    if (!snapshot) {
      return { kind: 'unread' };
    }
  }
  return { kind: 'decided', reason, snapshot };
}

/**
 * The cheap model's verdict on one pull request, logged as a run of its own whatever it came to. A
 * run that timed out, hit its budget or answered with nothing usable reached no verdict, and says
 * so in `note`: the triage is a cheap first pass, so it neither queues a review nobody asked for
 * nor lets the pull request pass for one that has been judged.
 */
async function askTheTriageModel(store: InboxStore, deps: TickDeps, snapshot: PrSnapshot): Promise<{ reason: string | null; note: string | null }> {
  const id = prId(snapshot);
  let diff = '';
  try {
    diff = await deps.forge.prDiff(snapshot);
  } catch (err) {
    deps.log(`${id}: the diff could not be read for triage — ${err instanceof Error ? err.message : err}`);
  }
  let result: TriageAgentResult;
  try {
    result = await deps.triageAgent({ snapshot, diff, alertWhen: deps.alertWhen });
  } catch (err) {
    const note = `the triage model could not be run: ${err instanceof Error ? err.message : err}`;
    deps.log(`${id}: ${note}`);
    return { reason: null, note };
  }
  store.recordRun(runRecordOf({
    prId: id,
    headSha: snapshot.headSha,
    phase: 'triage',
    outcome: result.run.outcome,
    startedAt: result.run.startedAt,
    endedAt: result.run.endedAt,
    stats: result.run.stats,
    configModel: deps.triage.model,
    note: result.run.note,
  }));
  if (result.run.note) {
    deps.log(`${id}: triage — ${result.run.note}`);
  }
  // Only a run that answered decided anything; anything else is a look to make again.
  return result.run.outcome === 'triaged'
    ? { reason: result.reason, note: null }
    : { reason: null, note: result.run.note ?? `the triage model ended as ${result.run.outcome}` };
}

/**
 * Whether a pull request the search no longer lists is still the reviewer's to review. Two are:
 * one the daemon posted the alert findings to itself, because that post is what withdrew the
 * review request, and one the triage took in, which was never requested at all. Either way the
 * reviewer's own review is what hands it over, so a review posted since settles it.
 */
function stillTheReviewers(pr: InboxPr, handled: Handled | null, takenIn: string | null): boolean {
  if (pr.autoPosted !== null && (handled === null || handled.at < pr.autoPosted.at)) {
    return true;
  }
  return takenIn !== null && (handled === null || handled.at < takenIn);
}

/**
 * When the triage took this pull request into the inbox, or null when it was not the triage that
 * put it there. What answers that is the triage's own record, not the row's reason: the free rules
 * write a reason onto a pull request the reviewer was asked for too, and that one retires when the
 * request goes, like any other.
 */
function takenInAt(store: InboxStore, id: string): string | null {
  const record = store.triageOf(id);
  return record?.outcome === 'alert' ? record.at : null;
}

/**
 * What the rules that cost nothing make of a pull request about to be prepared: the reviewer's own
 * body patterns first, then their own paths. A row that already carries a reason keeps it, and one
 * whose review is already prepared for this head has had its answer.
 */
function freeRuleReason(pr: InboxPr, snapshot: PrSnapshot, deps: TickDeps): string | null {
  if (pr.triageReason !== null || pr.preparedHeadSha === snapshot.headSha) {
    return null;
  }
  return bodyRuleReason(snapshot.body, deps.triage.bodyPatterns)
    ?? alertForPaths(snapshot.files, deps.alertPaths);
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
  await prepareOne(store, snapshot, deps, true, viewerLogin);
}

async function prepareOne(store: InboxStore, snapshot: PrSnapshot, deps: TickDeps, bumped: boolean, viewerLogin: string | null): Promise<void> {
  const id = prId(snapshot);
  // Claimed in the same breath as it is checked: a bump and a tick can reach the same pull request
  // at once, and two agents must not end up in one worktree.
  if (deps.inFlight.has(id)) {
    return;
  }
  const existing = store.get(id);
  deps.inFlight.add(id);
  store.setStatus(id, 'preparing', null);
  deps.log(`preparing ${id} — ${snapshot.title}`);

  let result: PrepareResult;
  try {
    result = await deps.prepare(snapshot, {
      bumped,
      alreadyPostedHead: existing?.autoPosted?.headSha ?? null,
      triageReason: existing?.triageReason ?? null,
      viewerLogin,
      reviewedHead: store.latestHandled(id)?.headSha ?? null,
    });
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
        // Only the agent names findings, so a path alert stands on its own with none.
        alertFindings: result.alertFindings,
      });
      if (result.posted) {
        store.markAutoPosted(id, result.posted);
      }
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
