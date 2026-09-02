import type { InboxPr, InboxStore } from './store.js';

export type OpenResolution =
  | { ok: true; pr: InboxPr }
  | { ok: false; status: number; message: string };

/**
 * Whether a pull request can be opened, and why not when it can't. Only a prepared (or stale but
 * still prepared) review has a worktree and a bundle to open; a queued, skipped or failed one has
 * nothing to show yet.
 */
export function resolveOpen(store: InboxStore, id: string): OpenResolution {
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
