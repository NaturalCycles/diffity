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

  it('takes the occurrence nearest to where the comment was, when the anchor identifies the code', () => {
    const anchor = 'const total = computeTotal(items);';
    const duplicated = [anchor, 'x', anchor, 'y', anchor];

    expect(reanchor(anchor, duplicated, 3)?.startLine).toBe(3);
    expect(reanchor(anchor, duplicated, 5)?.startLine).toBe(5);
    expect(reanchor(anchor, duplicated, 1)?.startLine).toBe(1);
  });

  it('refuses nearest-match when the anchor is too short to identify anything', () => {
    const duplicated = ['  return 1;', 'x', '  return 1;'];

    expect(reanchor('  return 1;', duplicated, 3)).toBeNull();
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

describe('reanchor refuses an ambiguous anchor', () => {
  const file = ['function a() {', '  work();', '}', '', 'function b() {', '  work();', '}'];

  it('will not move a short anchor that matches in several places', async () => {
    const { reanchor } = await import('../src/anchor.js');

    // `}` occurs twice, and the line it was written against is gone. Picking the nearest would
    // silently reattach the finding to a different function.
    expect(reanchor('}', file, 3)).toBeNull();
    expect(reanchor('  work();', file, 2)).toBeNull();
  });

  it('accepts a short anchor when it is the only match', async () => {
    const { reanchor } = await import('../src/anchor.js');

    expect(reanchor('  work();', ['pad', '  work();'], 1)).toEqual({ startLine: 2, endLine: 2 });
  });

  it('accepts an ambiguous but distinctive multi-line anchor', async () => {
    const { reanchor } = await import('../src/anchor.js');
    const twice = ['function b() {', '  work();', '}', 'gap', 'function b() {', '  work();', '}'];

    expect(reanchor('function b() {\n  work();', twice, 5)?.startLine).toBe(5);
  });
})
