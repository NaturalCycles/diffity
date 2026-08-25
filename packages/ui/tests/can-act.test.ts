import { describe, it, expect } from 'vitest';
import { canAskAgent, canActOnCode } from '../src/lib/live-mode';

describe('what the page offers', () => {
  const listening = { enabled: true, listening: true, waiting: 0, mayChangeCode: true };

  it('offers nothing when live mode is off', () => {
    expect(canAskAgent({ ...listening, enabled: false }, true)).toBe(false);
    expect(canActOnCode({ ...listening, enabled: false }, true)).toBe(false);
  });

  it('offers nothing when this diff has no review session', () => {
    expect(canAskAgent(listening, false)).toBe(false);
    expect(canActOnCode(listening, false)).toBe(false);
  });

  // Asking is always allowed where live mode is; acting is not.
  it('lets the reader ask on somebody else pull request but not act', () => {
    const someoneElses = { ...listening, mayChangeCode: false };

    expect(canAskAgent(someoneElses, true)).toBe(true);
    expect(canActOnCode(someoneElses, true)).toBe(false);
  });

  it('lets the reader do both on their own work', () => {
    expect(canAskAgent(listening, true)).toBe(true);
    expect(canActOnCode(listening, true)).toBe(true);
  });

  // Nobody listening is not a reason to hide the buttons: what you write is queued.
  it('offers both even when nobody is listening yet', () => {
    const quiet = { ...listening, listening: false };

    expect(canAskAgent(quiet, true)).toBe(true);
    expect(canActOnCode(quiet, true)).toBe(true);
  });

  it('offers nothing before the status has loaded', () => {
    expect(canAskAgent(undefined, true)).toBe(false);
    expect(canActOnCode(undefined, true)).toBe(false);
  });
});
