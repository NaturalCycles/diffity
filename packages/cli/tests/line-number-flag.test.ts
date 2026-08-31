import { describe, it, expect } from 'vitest';
import { InvalidArgumentError } from 'commander';
import { lineNumber } from '../src/agent.js';

describe('what --line accepts', () => {
  it('takes whole positive numbers, however written', () => {
    expect(lineNumber('3')).toBe(3);
    expect(lineNumber('1e2')).toBe(100);
  });

  it('rejects everything else with the raw input left to commander', () => {
    for (const raw of ['0', '-1', '4.5', '42abc', 'abc', '']) {
      expect(() => lineNumber(raw)).toThrowError(InvalidArgumentError);
    }
  });
});
