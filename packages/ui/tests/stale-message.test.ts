import { describe, it, expect } from 'vitest';
import { staleMessage } from '../src/lib/stale-files';

describe('what the banner says', () => {
  it('names one file', () => {
    expect(staleMessage(['src/live.ts'])).toBe('src/live.ts changed since this diff was loaded');
  });

  it('names two', () => {
    expect(staleMessage(['a.ts', 'b.ts'])).toBe('a.ts and b.ts changed since this diff was loaded');
  });

  it('counts rather than listing when there are many', () => {
    expect(staleMessage(['a.ts', 'b.ts', 'c.ts', 'd.ts'])).toBe('4 files changed since this diff was loaded');
  });

  // The fingerprint can move without a file line moving — a new commit changes what a range means.
  it('falls back when it cannot say which', () => {
    expect(staleMessage([])).toBe('Files have changed since this diff was loaded');
  });
});

describe('naming only what the reader can find', () => {
  // Git reports a rename as `src/{old.ts => new.ts}`, which is never a path in the file list. The
  // page filters those out before it gets here, so what arrives is nameable — and an empty list
  // has to fall back rather than say "0 files".
  it('falls back when everything that moved was unnameable', () => {
    expect(staleMessage([])).toBe('Files have changed since this diff was loaded');
  });

  it('names what is left when only some were nameable', () => {
    expect(staleMessage(['src/live.ts'])).toBe('src/live.ts changed since this diff was loaded');
  });
});
