import { describe, it, expect, beforeEach } from 'vitest';
import type { DiffFile, DiffLine } from '@diffity/parser';
import {
  buildEntryKey,
  evictOldest,
  fingerprintFile,
  fingerprintFiles,
  hashString,
  loadViewedFiles,
  reconcileViewed,
  saveViewedFiles,
} from '../src/lib/viewed-storage';

function makeLine(type: DiffLine['type'], content: string, oldLineNumber: number | null, newLineNumber: number | null): DiffLine {
  return { type, content, oldLineNumber, newLineNumber };
}

function makeFile(path: string, lines: DiffLine[], status: DiffFile['status'] = 'modified'): DiffFile {
  return {
    oldPath: status === 'added' ? '' : path,
    newPath: status === 'deleted' ? '' : path,
    status,
    additions: lines.filter(line => line.type === 'add').length,
    deletions: lines.filter(line => line.type === 'delete').length,
    isBinary: false,
    hunks: [
      {
        header: '@@ -1,3 +1,3 @@',
        oldStart: 1,
        oldCount: 3,
        newStart: 1,
        newCount: 3,
        lines,
      },
    ],
  };
}

// The baseline file every fingerprint case is compared against.
function baseFile(path = 'src/app.ts'): DiffFile {
  return makeFile(path, [
    makeLine('context', 'const a = 1;', 1, 1),
    makeLine('delete', 'const b = 2;', 2, null),
    makeLine('add', 'const b = 3;', null, 2),
    makeLine('context', 'export { a, b };', 3, 3),
  ]);
}

describe('hashString', () => {
  it('is stable for the same input', () => {
    expect(hashString('hello')).toBe(hashString('hello'));
  });

  it('differs for different input', () => {
    expect(hashString('hello')).not.toBe(hashString('world'));
  });

  it('handles the empty string', () => {
    expect(typeof hashString('')).toBe('string');
  });
});

describe('fingerprintFile', () => {
  it('is stable across calls for an identical file', () => {
    expect(fingerprintFile(baseFile())).toBe(fingerprintFile(baseFile()));
  });

  it('changes when a changed line is edited', () => {
    const edited = makeFile('src/app.ts', [
      makeLine('context', 'const a = 1;', 1, 1),
      makeLine('delete', 'const b = 2;', 2, null),
      makeLine('add', 'const b = 4;', null, 2),
      makeLine('context', 'export { a, b };', 3, 3),
    ]);

    expect(fingerprintFile(edited)).not.toBe(fingerprintFile(baseFile()));
  });

  it('ignores indentation-only differences so the whitespace filter does not churn marks', () => {
    const reindented = makeFile('src/app.ts', [
      makeLine('context', '  const a = 1;', 1, 1),
      makeLine('delete', '    const b = 2;', 2, null),
      makeLine('add', '    const b = 3;', null, 2),
      makeLine('context', '  export { a, b };', 3, 3),
    ]);

    expect(fingerprintFile(reindented)).toBe(fingerprintFile(baseFile()));
  });

  it('survives an unrelated edit elsewhere in the file shifting context and line numbers', () => {
    const shifted = makeFile('src/app.ts', [
      makeLine('context', 'const zero = 0;', 40, 41),
      makeLine('delete', 'const b = 2;', 41, null),
      makeLine('add', 'const b = 3;', null, 42),
      makeLine('context', 'const later = 9;', 42, 43),
    ]);

    expect(fingerprintFile(shifted)).toBe(fingerprintFile(baseFile()));
  });

  it('changes when the file is renamed', () => {
    const renamed = baseFile('src/renamed.ts');

    expect(fingerprintFile(renamed)).not.toBe(fingerprintFile(baseFile()));
  });

  it('changes when the status changes', () => {
    const deleted = makeFile('src/app.ts', baseFile().hunks[0].lines, 'deleted');

    expect(fingerprintFile(deleted)).not.toBe(fingerprintFile(baseFile()));
  });
});

describe('fingerprintFiles', () => {
  it('keys fingerprints by display path', () => {
    const fingerprints = fingerprintFiles([baseFile('src/a.ts'), baseFile('src/b.ts')]);

    expect(Object.keys(fingerprints).sort()).toEqual(['src/a.ts', 'src/b.ts']);
  });
});

describe('reconcileViewed', () => {
  it('keeps paths whose fingerprint is unchanged', () => {
    const viewed = reconcileViewed({ 'src/a.ts': 'abc' }, { 'src/a.ts': 'abc' });

    expect(viewed.has('src/a.ts')).toBe(true);
  });

  it('drops paths whose fingerprint changed', () => {
    const viewed = reconcileViewed({ 'src/a.ts': 'abc' }, { 'src/a.ts': 'xyz' });

    expect(viewed.has('src/a.ts')).toBe(false);
  });

  it('drops paths that are no longer in the diff', () => {
    const viewed = reconcileViewed({ 'src/gone.ts': 'abc' }, { 'src/a.ts': 'abc' });

    expect(viewed.has('src/gone.ts')).toBe(false);
  });

  it('keeps unchanged files while dropping the one that was edited', () => {
    const viewed = reconcileViewed(
      { 'src/a.ts': 'abc', 'src/b.ts': 'def' },
      { 'src/a.ts': 'abc', 'src/b.ts': 'CHANGED' },
    );

    expect([...viewed]).toEqual(['src/a.ts']);
  });
});

describe('evictOldest', () => {
  it('leaves the store alone when under the cap', () => {
    const entries = {
      a: { updatedAt: 1, seq: 1, files: {} },
      b: { updatedAt: 2, seq: 2, files: {} },
    };

    expect(Object.keys(evictOldest(entries, 10))).toHaveLength(2);
  });

  it('drops the least recently used entries past the cap', () => {
    const entries = {
      oldest: { updatedAt: 1, seq: 1, files: {} },
      middle: { updatedAt: 2, seq: 2, files: {} },
      newest: { updatedAt: 3, seq: 3, files: {} },
    };

    expect(Object.keys(evictOldest(entries, 2)).sort()).toEqual(['middle', 'newest']);
  });

  it('orders by write sequence, not wall clock, so same-millisecond writes still evict correctly', () => {
    const entries = {
      oldest: { updatedAt: 1000, seq: 1, files: {} },
      middle: { updatedAt: 1000, seq: 2, files: {} },
      newest: { updatedAt: 1000, seq: 3, files: {} },
    };

    expect(Object.keys(evictOldest(entries, 2)).sort()).toEqual(['middle', 'newest']);
  });
});

describe('localStorage round-trip', () => {
  beforeEach(() => {
    const store = new Map<string, string>();
    // vitest runs these in the node environment, so stand up a minimal localStorage.
    (globalThis as { localStorage?: unknown }).localStorage = {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => void store.set(key, value),
      removeItem: (key: string) => void store.delete(key),
      clear: () => store.clear(),
    };
  });

  it('returns an empty map when nothing is stored', () => {
    expect(loadViewedFiles('/repo', 'work')).toEqual({});
  });

  it('round-trips viewed files for a repo and ref', () => {
    saveViewedFiles('/repo', 'work', { 'src/a.ts': 'abc' });

    expect(loadViewedFiles('/repo', 'work')).toEqual({ 'src/a.ts': 'abc' });
  });

  it('keeps refs in the same repo isolated', () => {
    saveViewedFiles('/repo', 'work', { 'src/a.ts': 'abc' });
    saveViewedFiles('/repo', 'main', { 'src/b.ts': 'def' });

    expect(loadViewedFiles('/repo', 'work')).toEqual({ 'src/a.ts': 'abc' });
    expect(loadViewedFiles('/repo', 'main')).toEqual({ 'src/b.ts': 'def' });
  });

  it('keeps repos isolated so a recycled port cannot leak state', () => {
    saveViewedFiles('/repo-one', 'work', { 'src/a.ts': 'abc' });

    expect(loadViewedFiles('/repo-two', 'work')).toEqual({});
  });

  it('clears the entry when the last file is unmarked', () => {
    saveViewedFiles('/repo', 'work', { 'src/a.ts': 'abc' });
    saveViewedFiles('/repo', 'work', {});

    expect(loadViewedFiles('/repo', 'work')).toEqual({});
  });

  it('evicts the oldest ref once more than ten are stored', () => {
    for (let i = 0; i < 11; i++) {
      saveViewedFiles('/repo', `ref-${i}`, { 'src/a.ts': `fp-${i}` });
    }

    expect(loadViewedFiles('/repo', 'ref-0')).toEqual({});
    expect(loadViewedFiles('/repo', 'ref-10')).toEqual({ 'src/a.ts': 'fp-10' });
  });

  it('recovers from corrupt stored JSON instead of throwing', () => {
    localStorage.setItem('diffity-viewed', '{not json');

    expect(loadViewedFiles('/repo', 'work')).toEqual({});
  });

  it('ignores a store written by a future version', () => {
    localStorage.setItem('diffity-viewed', JSON.stringify({
      version: 99,
      entries: { [buildEntryKey('/repo', 'work')]: { updatedAt: 1, files: { 'src/a.ts': 'abc' } } },
    }));

    expect(loadViewedFiles('/repo', 'work')).toEqual({});
  });
});
