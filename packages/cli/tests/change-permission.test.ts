import { describe, it, expect } from 'vitest';
import { resolveMayChangeCode } from '../src/live-permissions.js';

describe('whether the agent may change code here', () => {
  const mine = { viewerDidAuthor: true };
  const theirs = { viewerDidAuthor: false };

  // Nothing said: fall back to who wrote it, which is what it did before there was a flag.
  it('derives it from authorship when nobody said', () => {
    expect(resolveMayChangeCode(undefined, mine)).toBe(true);
    expect(resolveMayChangeCode(undefined, theirs)).toBe(false);
    expect(resolveMayChangeCode(undefined, null)).toBe(true);
  });

  // Taking over somebody else's branch is the case authorship gets wrong, and the agent that
  // launched diffity is the one that knows.
  it('lets the launcher say this is work rather than review', () => {
    expect(resolveMayChangeCode('work', theirs)).toBe(true);
  });

  // And the other way: reviewing your own pull request should not invite edits mid-review.
  it('lets the launcher say this is review rather than work', () => {
    expect(resolveMayChangeCode('review', mine)).toBe(false);
    expect(resolveMayChangeCode('review', null)).toBe(false);
  });

  it('ignores anything it does not recognise rather than guessing', () => {
    expect(resolveMayChangeCode('sideways' as never, theirs)).toBe(false);
    expect(resolveMayChangeCode('sideways' as never, mine)).toBe(true);
  });
});
