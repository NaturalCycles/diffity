import { describe, it, expect } from 'vitest';
import { reanchor } from '../src/anchor.js';

const file = [
  'import { a } from "a";',
  '',
  'function first() {',
  '  return 1;',
  '}',
  '',
  'function second() {',
  '  return 2;',
  '}',
];

describe('reanchor', () => {
  it('finds the lines where they now are', () => {
    const moved = reanchor('function second() {\n  return 2;', ['// new header', ...file], 7);

    expect(moved).toEqual({ startLine: 8, endLine: 9 });
  });

  it('leaves a line that has not moved alone', () => {
    expect(reanchor('  return 1;', file, 4)).toEqual({ startLine: 4, endLine: 4 });
  });

  it('gives up when the line was edited rather than moved', () => {
    expect(reanchor('  return 1; // changed', file, 4)).toBeNull();
  });

  it('gives up when the code is gone', () => {
    expect(reanchor('function third() {', file, 4)).toBeNull();
  });

  it('takes the occurrence nearest to where the comment was', () => {
    const duplicated = ['  return 1;', 'x', '  return 1;', 'y', '  return 1;'];

    expect(reanchor('  return 1;', duplicated, 3)?.startLine).toBe(3);
    expect(reanchor('  return 1;', duplicated, 5)?.startLine).toBe(5);
    expect(reanchor('  return 1;', duplicated, 1)?.startLine).toBe(1);
  });

  it('refuses an empty anchor rather than matching everywhere', () => {
    expect(reanchor('', file, 1)).toBeNull();
  });

  it('handles an anchor longer than the file', () => {
    expect(reanchor(file.join('\n') + '\nextra', file, 1)).toBeNull();
  });
});

describe('clampToFile', () => {
  it('trims a range that runs past the end of the file', async () => {
    const { clampToFile } = await import('../src/anchor.js');

    // A five-line file; a comment claiming lines 4-40 means lines 4-5.
    expect(clampToFile(['a', 'b', 'c', 'd', 'e'].length, 4, 40)).toEqual({ startLine: 4, endLine: 5 });
  });

  it('leaves a range inside the file alone', async () => {
    const { clampToFile } = await import('../src/anchor.js');

    expect(clampToFile(10, 3, 7)).toEqual({ startLine: 3, endLine: 7 });
  });

  it('pins a start line past the end to the last line', async () => {
    const { clampToFile } = await import('../src/anchor.js');

    expect(clampToFile(5, 9, 12)).toEqual({ startLine: 5, endLine: 5 });
  });

  it('does nothing when the file length is unknown', async () => {
    const { clampToFile } = await import('../src/anchor.js');

    expect(clampToFile(null, 4, 40)).toEqual({ startLine: 4, endLine: 40 });
  });
})

describe('countLines', () => {
  it('does not count the empty string after a trailing newline', async () => {
    const { countLines } = await import('../src/anchor.js');

    expect(countLines('a\nb\nc\n')).toBe(3);
  });

  it('counts a file with no trailing newline', async () => {
    const { countLines } = await import('../src/anchor.js');

    expect(countLines('a\nb\nc')).toBe(3);
  });

  it('handles the empty file', async () => {
    const { countLines } = await import('../src/anchor.js');

    expect(countLines('')).toBe(0);
    expect(countLines('\n')).toBe(1);
  });
})
