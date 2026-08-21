import { describe, it, expect } from 'vitest';
import { resolveInitialTheme } from '../src/hooks/use-theme';

describe('resolveInitialTheme', () => {
  it('follows the system when nothing else was chosen', () => {
    expect(resolveInitialTheme(null, null, true)).toBe('dark');
    expect(resolveInitialTheme(null, null, false)).toBe('light');
  });

  it('prefers an explicit flag over the system preference', () => {
    expect(resolveInitialTheme(null, 'light', true)).toBe('light');
    expect(resolveInitialTheme(null, 'dark', false)).toBe('dark');
  });

  it('prefers the reader\'s stored choice over everything else', () => {
    expect(resolveInitialTheme('light', 'dark', true)).toBe('light');
    expect(resolveInitialTheme('dark', 'light', false)).toBe('dark');
  });

  it('treats a missing initial theme the same as a null one', () => {
    expect(resolveInitialTheme(null, undefined, true)).toBe('dark');
  });
});
