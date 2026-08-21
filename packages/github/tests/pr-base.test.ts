import { describe, it, expect } from 'vitest';
import { parsePrBase } from '../src/pr-url.js';

describe('parsePrBase', () => {
  it('returns the base branch name and the commit it points at', () => {
    const json = JSON.stringify({
      baseRefName: 'master',
      baseRefOid: '24e3eeab4c62927d05341e3eb9347c272fa7e3af',
    });

    expect(parsePrBase(json)).toEqual({
      name: 'master',
      oid: '24e3eeab4c62927d05341e3eb9347c272fa7e3af',
    });
  });

  it('rejects a response without the oid, rather than diffing against a local branch', () => {
    const json = JSON.stringify({ baseRefName: 'master' });

    expect(() => parsePrBase(json)).toThrow(/baseRefName or baseRefOid/);
  });

  it('rejects a response without the branch name', () => {
    const json = JSON.stringify({ baseRefOid: '24e3eeab4c' });

    expect(() => parsePrBase(json)).toThrow(/baseRefName or baseRefOid/);
  });
});
