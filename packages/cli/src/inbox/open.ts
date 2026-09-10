import type { Handled, InboxPr, InboxStore } from './store.js';

export const BUMPABLE: ReadonlySet<InboxPr['status']> = new Set(['queued', 'skipped', 'failed', 'dismissed', 'handled']);

/**
 * Whether a fresh review of the current head is something to offer for this row. The statuses
 * above are, and so is a prepared review the reviewer has since posted from: the poll after the
 * posting is what turns that one `handled`, and until then the row reads as reviewed with no way
 * to ask for the next review.
 */
export function isBumpable(pr: InboxPr, handled: Handled | null): boolean {
  if (BUMPABLE.has(pr.status)) {
    return true;
  }
  return (pr.status === 'prepared' || pr.status === 'stale')
    && handled !== null && handled.at > (pr.preparedAt ?? '');
}

export type Resolution =
  | { ok: true; pr: InboxPr }
  | { ok: false; status: number; message: string };

/**
 * Whether a pull request can be opened, and why not when it can't. Only a prepared (or stale but
 * still prepared) review has a worktree and a bundle to open; a queued, skipped or failed one has
 * nothing to show yet.
 */
export function resolveOpen(store: InboxStore, id: string): Resolution {
  const pr = store.get(id);
  if (!pr) {
    return { ok: false, status: 404, message: `No pull request ${id} in the inbox.` };
  }
  if (pr.status !== 'prepared' && pr.status !== 'stale') {
    return { ok: false, status: 409, message: `${id} is ${pr.status}, not ready to open.` };
  }
  if (!pr.worktreePath || !pr.bundlePath) {
    return { ok: false, status: 409, message: `${id} has no prepared worktree to open.` };
  }
  return { ok: true, pr };
}

/**
 * Whether a pull request can be dismissed right now. One being prepared cannot: the run in flight
 * would finish and mark it prepared over the dismissal.
 */
export function resolveDismiss(store: InboxStore, id: string): Resolution {
  const pr = store.get(id);
  if (!pr) {
    return { ok: false, status: 404, message: `No pull request ${id} in the inbox.` };
  }
  if (pr.status === 'preparing') {
    return { ok: false, status: 409, message: `${id} is being prepared right now; dismiss it once that has finished.` };
  }
  return { ok: true, pr };
}

/**
 * Whether a pull request can be bumped to the front of the queue: one that is waiting, one a verdict
 * or a failure set aside, one the reviewer dismissed and wants back, or one already reviewed —
 * settled as such or just posted from — whose current head they want a fresh review of. A prepared
 * review nobody has posted from, or one being prepared, has nothing to gain.
 */
export function resolveBump(store: InboxStore, id: string): Resolution {
  const pr = store.get(id);
  if (!pr) {
    return { ok: false, status: 404, message: `No pull request ${id} in the inbox.` };
  }
  if (!isBumpable(pr, store.latestHandled(id))) {
    return { ok: false, status: 409, message: `${id} is ${pr.status}; only a queued, skipped, failed, dismissed or handled pull request can be bumped.` };
  }
  return { ok: true, pr };
}
