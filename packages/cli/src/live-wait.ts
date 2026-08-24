/**
 * Node's `fetch` gives up on a request whose response headers have not arrived within 300 seconds
 * — undici's `headersTimeout`, which cannot be raised without reaching for undici directly. This
 * server sends no headers until it has something to hand over, so a listener asking for longer
 * dies at 301s with `HeadersTimeoutError`, indistinguishable from the server going away.
 *
 * Re-arming is already how the loop works, so waiting in shorter stretches costs nothing.
 */
export const CLIENT_WAIT_CAP_SECONDS = 240;

export function clampClientWait(seconds: number): number {
  if (!Number.isFinite(seconds) || seconds <= 0) {
    return 0;
  }
  return Math.min(seconds, CLIENT_WAIT_CAP_SECONDS);
}
