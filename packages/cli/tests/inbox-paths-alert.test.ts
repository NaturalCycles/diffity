import { describe, it, expect } from 'vitest';
import { alertForPaths } from '../src/inbox/paths-alert.js';

function files(...paths: string[]): { path: string }[] {
  return paths.map(path => ({ path }));
}

describe('alertForPaths', () => {
  it('names the first changed file that matches, and counts the rest', () => {
    expect(alertForPaths(files('README.md', 'packages/shared/src/model/x.ts'), ['packages/shared/src/model/**']))
      .toBe('touches packages/shared/src/model/x.ts');
    expect(alertForPaths(
      files('packages/shared/src/model/x.ts', 'README.md', 'packages/shared/src/model/y.ts'),
      ['packages/shared/src/model/**'],
    )).toBe('touches packages/shared/src/model/x.ts and 1 more');
  });

  it('spans directories with **, stays in one segment with * and ?', () => {
    expect(alertForPaths(files('src/dbref/a.ts'), ['**/dbref/**'])).toBe('touches src/dbref/a.ts');
    // A leading **/ matches no directory at all as readily as several.
    expect(alertForPaths(files('dbref/a.ts'), ['**/dbref/**'])).toBe('touches dbref/a.ts');
    expect(alertForPaths(files('a/b/c/dbref/deep/a.ts'), ['**/dbref/**'])).toBe('touches a/b/c/dbref/deep/a.ts');
    // The directory itself, with nothing under it named.
    expect(alertForPaths(files('packages/shared/src/model'), ['packages/shared/src/model/**']))
      .toBe('touches packages/shared/src/model');
    expect(alertForPaths(files('src/nested/a.ts'), ['src/*.ts'])).toBeNull();
    expect(alertForPaths(files('src/a.ts'), ['src/*.ts'])).toBe('touches src/a.ts');
    expect(alertForPaths(files('src/a.tsx'), ['src/a.ts?'])).toBe('touches src/a.tsx');
  });

  it('is null with nothing to match, nothing to match against, or no match', () => {
    expect(alertForPaths(files('src/a.ts'), [])).toBeNull();
    expect(alertForPaths([], ['src/**'])).toBeNull();
    expect(alertForPaths(files('README.md'), ['src/**', '**/dbref/**'])).toBeNull();
  });

  it('treats every other character in a glob as the literal it is', () => {
    expect(alertForPaths(files('src/a.ts'), ['src/a+ts'])).toBeNull();
    expect(alertForPaths(files('src/a+ts'), ['src/a+ts'])).toBe('touches src/a+ts');
  });
});
