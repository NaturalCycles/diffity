import { describe, it, expect } from 'vitest';
import { CLIENT_WAIT_CAP_SECONDS, clampClientWait } from '../src/live-wait.js';

describe('how long a listener may ask to wait', () => {
  // Node's fetch abandons a request whose headers have not arrived within 300s
  // (undici's headersTimeout), and this server sends none until it has an answer. A listener that
  // asked for longer died at 301s with HeadersTimeoutError, which read as the server going away.
  it('stays under what node will wait for headers', () => {
    expect(CLIENT_WAIT_CAP_SECONDS).toBeLessThan(300);
  });

  it('leaves a short wait alone', () => {
    expect(clampClientWait(60)).toBe(60);
    expect(clampClientWait(0)).toBe(0);
  });

  it('caps a long one rather than letting it die mid-wait', () => {
    expect(clampClientWait(900)).toBe(CLIENT_WAIT_CAP_SECONDS);
  });

  it('treats nonsense as no wait', () => {
    expect(clampClientWait(Number.NaN)).toBe(0);
    expect(clampClientWait(-5)).toBe(0);
  });
});
