import { describe, it, expect } from 'vitest';
import { renamedPaths, followRename } from '../src/renames.js';

describe('renamedPaths', () => {
  it('reads a rename out of --name-status', () => {
    const moves = renamedPaths('R100\tscripts/medical/const.ts\tscripts/llm/const.ts');

    expect(moves.get('scripts/medical/const.ts')).toBe('scripts/llm/const.ts');
  });

  it('takes a partial rename too, which is any R with a similarity below 100', () => {
    expect(renamedPaths('R087\told.ts\tnew.ts').get('old.ts')).toBe('new.ts');
  });

  it('reads several', () => {
    expect(renamedPaths('R100\ta.ts\tb.ts\nR100\tc.ts\td.ts').size).toBe(2);
  });

  // A copy leaves the original in place, so following it would take a finding off the file it was
  // written about. git only reports copies under -C, which is not asked for.
  it('is not fooled by a copy', () => {
    expect(renamedPaths('C100\ta.ts\tb.ts').size).toBe(0);
  });

  it('ignores everything that is not a rename', () => {
    expect(renamedPaths('M\ta.ts\nA\tb.ts\nD\tc.ts\n').size).toBe(0);
  });

  it('is empty on empty output', () => {
    expect(renamedPaths('').size).toBe(0);
    expect(renamedPaths('\n\n').size).toBe(0);
  });
});

describe('followRename', () => {
  const moves = new Map([['a.ts', 'b.ts'], ['b.ts', 'c.ts']]);

  it('leaves a path nothing moved', () => {
    expect(followRename('untouched.ts', moves)).toBe('untouched.ts');
  });

  // A review can span several commits, and a file can be moved twice across them.
  it('follows a chain', () => {
    expect(followRename('a.ts', moves)).toBe('c.ts');
  });

  it('stops rather than looping when two files swap', () => {
    expect(followRename('x.ts', new Map([['x.ts', 'y.ts'], ['y.ts', 'x.ts']]))).toBe('y.ts');
  });
});
