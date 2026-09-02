import type { PrRef, PrSnapshot } from '@diffity/github';
import { reconcile } from './reconcile.js';
import { prId, type InboxPr, type InboxStore } from './store.js';
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
  prepare(snapshot: PrSnapshot): Promise<PrepareResult>;
  removeWorktree(worktree: string, repo: string): void;
  log(message: string): void;
  now(): string;
  /** False once the daemon is shutting down, so the drain stops starting new preparations. */
  shouldContinue?(): boolean;
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
        deps.removeWorktree(pr.worktreePath, pr.repo);
        store.setPaths(pr.id, { worktreePath: null });
      }
    }
  }

  for (const snapshot of toPrepare) {
    if (deps.shouldContinue && !deps.shouldContinue()) {
      break;
    }
    await prepareOne(store, snapshot, deps);
  }
}

async function prepareOne(store: InboxStore, snapshot: PrSnapshot, deps: TickDeps): Promise<void> {
  const id = prId(snapshot);
  store.setStatus(id, 'preparing', null);
  deps.log(`preparing ${id} — ${snapshot.title}`);

  const result = await deps.prepare(snapshot);
  switch (result.kind) {
    case 'prepared':
      store.markPrepared(id, {
        headSha: result.headSha,
        bundlePath: result.bundlePath,
        worktreePath: result.worktree,
        logPath: result.logPath,
        at: result.at,
      });
      deps.log(`prepared ${id}`);
      return;
    case 'skipped':
      store.setStatus(id, 'skipped', result.reason);
      store.setPaths(id, { worktreePath: null, logPath: result.logPath });
      deps.log(`skipped ${id}: ${result.reason}`);
      return;
    case 'failed':
      store.failAttempt(id, result.reason);
      store.setPaths(id, { worktreePath: result.worktree ?? null, logPath: result.logPath ?? null });
      deps.log(`failed to prepare ${id}: ${result.reason}`);
      return;
  }
}

function isRetired(status: InboxPr['status']): boolean {
  return status === 'done' || status === 'hidden';
}

function prToRef(pr: InboxPr): PrRef {
  return { owner: pr.owner, repo: pr.repo, number: pr.number };
}
