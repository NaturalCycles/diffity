/** How long after the last request from a page we still call somebody present. */
export const VIEWER_IDLE_MS = 20_000;

let lastSeenAt = 0;

/**
 * A page asked for something. The page polls every couple of seconds, so its requests are the only
 * evidence a window is open — there is no connection to watch, and a closed tab and an idle one look
 * identical apart from this.
 */
export function noteViewerSeen(now = Date.now()): void {
  lastSeenAt = now;
}

export function lastViewerSeenAt(): number {
  return lastSeenAt;
}

export function viewerIsPresent(lastSeen: number, now: number, idleMs = VIEWER_IDLE_MS): boolean {
  if (lastSeen === 0) {
    return false;
  }
  return now - lastSeen < idleMs;
}

/**
 * A window was open and has stopped asking — as distinct from one that has never been open.
 *
 * The difference decides whether waiting is pointless or merely early: an agent is often armed
 * before the reader opens the page, and stopping then would mean the loop never got going.
 */
export function viewerHasGone(lastSeen: number, now: number, idleMs = VIEWER_IDLE_MS): boolean {
  return lastSeen !== 0 && !viewerIsPresent(lastSeen, now, idleMs);
}

/** Only used by tests, which would otherwise inherit whatever the last one left behind. */
export function resetViewerSeen(): void {
  lastSeenAt = 0;
}
