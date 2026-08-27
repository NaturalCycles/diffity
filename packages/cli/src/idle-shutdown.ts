/** How often the check runs. */
export const IDLE_CHECK_MS = 30_000;

/** How long after a reader closes the page we wait before giving up on them coming back. */
export const AFTER_VIEWER_LEFT_MS = 300_000;

/** How long a server nobody has ever opened stays up. */
export const NEVER_OPENED_MS = 7_200_000;

export interface IdleFacts {
  /** A page was open and is not any more. */
  viewerGone: boolean;
  /** A page has been open at some point. */
  everSeen: boolean;
  /** Monotonic milliseconds since the last sign of a page, or since the server started. */
  idleForMs: number;
  /** An agent parked waiting for a question. */
  listeners: number;
  /** An agent part-way through a review, whose findings the reader has not seen yet. */
  reviewInProgress: boolean;
  /** Overridden only by tests. */
  graceMs?: number;
}

/**
 * Whether this server has finished being useful.
 *
 * Two ways to be done, and they need different patience. A reader who closes the page has almost
 * certainly finished, but reopening from history is normal, so the URL has to keep working for a
 * while. A server nobody has ever opened is a different thing: usually one an agent started, and it
 * may sit unopened for a long time before the reader gets to it, so it is given hours.
 *
 * Never while an agent is parked or a review is unfinished. Both mean somebody intends to come
 * back, and a dead port is worse than an idle process.
 *
 * The times are monotonic, so a suspended laptop does not age a server towards its own shutdown —
 * closing the lid on an open review and returning to it tomorrow spends none of the grace.
 */
export function shouldShutDown(facts: IdleFacts): boolean {
  if (facts.listeners > 0 || facts.reviewInProgress) {
    return false;
  }

  if (facts.viewerGone) {
    return facts.idleForMs >= (facts.graceMs ?? AFTER_VIEWER_LEFT_MS);
  }

  if (!facts.everSeen) {
    return facts.idleForMs >= NEVER_OPENED_MS;
  }

  return false;
}
