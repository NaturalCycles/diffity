import { describe, it, expect } from 'vitest';
import { renamedPaths, followRename } from '../src/renames.js';

const file = (status: string, oldPath: string, newPath: string) => ({ status, oldPath, newPath });

describe('renamedPaths', () => {
  it('takes what git called a rename', () => {
    const moves = renamedPaths([file('renamed', 'scripts/medical/const.ts', 'scripts/llm/const.ts')]);

    expect(moves.get('scripts/medical/const.ts')).toBe('scripts/llm/const.ts');
  });

  it('takes a copy too, since the old path may be gone either way', () => {
    expect(renamedPaths([file('copied', 'a.ts', 'b.ts')]).get('a.ts')).toBe('b.ts');
  });

  it('ignores files that did not move', () => {
    const moves = renamedPaths([
      file('modified', 'a.ts', 'a.ts'),
      file('added', '', 'b.ts'),
      file('deleted', 'c.ts', ''),
      file('renamed', 'd.ts', 'd.ts'),
    ]);

    expect(moves.size).toBe(0);
  });
});

describe('followRename', () => {
  const moves = new Map([['a.ts', 'b.ts'], ['b.ts', 'c.ts']]);

  it('leaves a path nothing moved', () => {
    expect(followRename('untouched.ts', moves)).toBe('untouched.ts');
  });

  it('follows a rename', () => {
    expect(followRename('b.ts', moves)).toBe('c.ts');
  });

  // A review can span several commits, and a file can be moved twice across them.
  it('follows a chain of them', () => {
    expect(followRename('a.ts', moves)).toBe('c.ts');
  });

  it('stops rather than looping when two files swap', () => {
    expect(followRename('x.ts', new Map([['x.ts', 'y.ts'], ['y.ts', 'x.ts']]))).toBe('y.ts');
  });
});
