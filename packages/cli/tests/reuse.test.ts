import { describe, it, expect } from 'vitest';
import { shouldOpenExisting } from '../src/reuse.js';

describe('reusing a running instance', () => {
  it('does not open a second tab for the same view', () => {
    expect(shouldOpenExisting({ existingRef: 'main', requestedRef: 'main', openFlag: true })).toBe(false);
  });

  it('opens when the ref asked for is a different diff', () => {
    expect(shouldOpenExisting({ existingRef: 'main', requestedRef: 'work', openFlag: true })).toBe(true);
  });

  it('respects --no-open either way', () => {
    expect(shouldOpenExisting({ existingRef: 'main', requestedRef: 'work', openFlag: false })).toBe(false);
    expect(shouldOpenExisting({ existingRef: 'main', requestedRef: 'main', openFlag: false })).toBe(false);
  });

  it('treats an unknown existing ref as a different view', () => {
    expect(shouldOpenExisting({ existingRef: undefined, requestedRef: 'main', openFlag: true })).toBe(true);
  });
});
