import { describe, it, expect } from 'vitest';
import { readReadingPosition, writeReadingPosition, clearReadingPosition } from '../src/lib/reading-position';

function fakeStorage(): Storage {
  const map = new Map<string, string>();
  return {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    removeItem: (k: string) => void map.delete(k),
    clear: () => map.clear(),
    key: () => null,
    length: 0,
  } as unknown as Storage;
}

describe('remembering where someone was reading', () => {
  it('has nothing to say before anyone has read anything', () => {
    expect(readReadingPosition(fakeStorage(), '/repo', 'main')).toBeNull();
  });

  it('comes back with the file that was on screen', () => {
    const store = fakeStorage();
    writeReadingPosition(store, '/repo', 'main', 'src/a.ts');

    expect(readReadingPosition(store, '/repo', 'main')).toBe('src/a.ts');
  });

  // A position belongs to one diff. Restoring the place from another ref would scroll you into a
  // file you were not reading, which is worse than starting at the top.
  it('keeps one diff out of another', () => {
    const store = fakeStorage();
    writeReadingPosition(store, '/repo', 'main', 'src/a.ts');

    expect(readReadingPosition(store, '/repo', 'other-ref')).toBeNull();
    expect(readReadingPosition(store, '/other-repo', 'main')).toBeNull();
  });

  it('forgets on request, for when the reader starts over', () => {
    const store = fakeStorage();
    writeReadingPosition(store, '/repo', 'main', 'src/a.ts');
    clearReadingPosition(store, '/repo', 'main');

    expect(readReadingPosition(store, '/repo', 'main')).toBeNull();
  });
});
