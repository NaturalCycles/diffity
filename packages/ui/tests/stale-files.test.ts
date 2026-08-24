import { describe, it, expect } from 'vitest';
import { changedSince } from '../src/lib/stale-files';

describe('which files moved under the reader', () => {
  it('names the one that changed and not the others', () => {
    const before = { 'a.ts': '2 +-', 'b.ts': '4 ++--' };
    const after = { 'a.ts': '2 +-', 'b.ts': '9 +++++----' };

    expect(changedSince(before, after)).toEqual(['b.ts']);
  });

  it('names a file that has appeared', () => {
    expect(changedSince({ 'a.ts': '2 +-' }, { 'a.ts': '2 +-', 'new.ts': '3 +++' })).toEqual(['new.ts']);
  });

  it('names a file that has gone', () => {
    expect(changedSince({ 'a.ts': '2 +-', 'gone.ts': '1 +' }, { 'a.ts': '2 +-' })).toEqual(['gone.ts']);
  });

  it('says nothing when nothing moved', () => {
    const same = { 'a.ts': '2 +-' };
    expect(changedSince(same, { ...same })).toEqual([]);
  });

  // Before the first poll lands there is no baseline, and everything would otherwise read as new.
  it('says nothing without a baseline', () => {
    expect(changedSince(null, { 'a.ts': '2 +-' })).toEqual([]);
  });
});
