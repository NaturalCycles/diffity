/**
 * How long after the last sign of a page we still call somebody present.
 *
 * Generous because it is the fallback, not the main signal: a closed tab says so explicitly, and
 * this only has to catch a crash or a kill. It also has to survive a hidden tab, where browsers
 * throttle timers to roughly one a minute.
 */
export const VIEWER_IDLE_MS = 180_000;

/**
 * Elapsed time that a suspended laptop does not add to.
 *
 * `Date.now()` is the wall clock, and a lid closed overnight moves it by hours — so on wake, a
 * reader whose tab is still open and about to send its next heartbeat looks as though they left
 * long ago. `CLOCK_MONOTONIC`, which is what `hrtime` reads, excludes suspended time on Linux and
 * macOS, so a suspend simply does not count and waking up needs no special case. (This machine had
 * 89 hours of suspend inside 9 days of uptime when that was measured.)
 */
export function monotonicMs(): number {
  return Number(process.hrtime.bigint() / 1_000_000n);
}

/** How often a wait re-checks whether the page is still there. */
export const VIEWER_POLL_MS = 5_000;

export interface ViewerState {
  lastSeenAt: number;
  /** Whether a page has ever been open, which is not the same as one being open now. */
  everSeen: boolean;
}

let state: ViewerState = { lastSeenAt: 0, everSeen: false };

/**
 * A page said it is there. Its own heartbeat, rather than any request it happens to make: react
 * query stops polling a hidden tab, so ordinary traffic goes quiet while the window is still open.
 *
 * The stamp is monotonic, so it is only ever compared with `monotonicMs()`.
 */
export function noteViewerSeen(now = monotonicMs()): void {
  state = { lastSeenAt: now, everSeen: true };
}

/** The page said it is going away, which beats waiting for silence to prove it. */
export function markViewerGone(): void {
  state = { lastSeenAt: 0, everSeen: true };
}

export function viewerSnapshot(): ViewerState {
  return state;
}

export function viewerIsPresent(snapshot: ViewerState, now: number, idleMs = VIEWER_IDLE_MS): boolean {
  if (snapshot.lastSeenAt === 0) {
    return false;
  }
  return now - snapshot.lastSeenAt < idleMs;
}

/**
 * A window was open and is not any more — as distinct from one that has never been open.
 *
 * The difference decides whether waiting is pointless or merely early: an agent is usually armed
 * before the reader opens the page, and stopping then would end the loop before it began.
 */
export function viewerHasGone(snapshot: ViewerState, now: number, idleMs = VIEWER_IDLE_MS): boolean {
  return snapshot.everSeen && !viewerIsPresent(snapshot, now, idleMs);
}

/** Only used by tests, which would otherwise inherit whatever the last one left behind. */
export function resetViewerSeen(): void {
  state = { lastSeenAt: 0, everSeen: false };
}
