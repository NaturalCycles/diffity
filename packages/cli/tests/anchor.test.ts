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
