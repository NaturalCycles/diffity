import { describe, it, expect } from 'vitest';
import { readPanelOpen, writePanelOpen } from '../src/lib/panel-state';

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

describe('remembering whether a panel is open', () => {
  // The pull request panel is fetched after first paint, so it mounts late — and mounts again
  // whenever the page's queries are rebuilt. Without this it springs open each time, undoing a
  // reader who had collapsed it.
  it('is open until someone closes it', () => {
    expect(readPanelOpen(fakeStorage(), 'pr', '/repo')).toBe(true);
  });

  it('stays closed once closed', () => {
    const store = fakeStorage();
    writePanelOpen(store, 'pr', '/repo', false);

    expect(readPanelOpen(store, 'pr', '/repo')).toBe(false);
  });

  it('opens again when reopened', () => {
    const store = fakeStorage();
    writePanelOpen(store, 'pr', '/repo', false);
    writePanelOpen(store, 'pr', '/repo', true);

    expect(readPanelOpen(store, 'pr', '/repo')).toBe(true);
  });

  it('keeps one checkout out of another', () => {
    const store = fakeStorage();
    writePanelOpen(store, 'pr', '/repo-a', false);

    expect(readPanelOpen(store, 'pr', '/repo-b')).toBe(true);
  });
});
