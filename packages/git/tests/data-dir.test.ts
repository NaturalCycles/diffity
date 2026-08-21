import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { readRepoConfig, resolveDataDir } from '../src/config.js';

let repoRoot: string;
const homeDir = '/home/someone';

beforeEach(() => {
  repoRoot = mkdtempSync(join(tmpdir(), 'diffity-datadir-'));
});

afterEach(() => {
  rmSync(repoRoot, { recursive: true, force: true });
});

describe('resolveDataDir', () => {
  it('keeps repositories apart under the shared default', () => {
    const a = resolveDataDir({ repoRoot: '/repos/a', homeDir });
    const b = resolveDataDir({ repoRoot: '/repos/b', homeDir });

    expect(a).toMatch(/^\/home\/someone\/\.diffity\/[0-9a-f]{12}$/);
    expect(a).not.toBe(b);
  });

  it('is stable for the same repository', () => {
    expect(resolveDataDir({ repoRoot: '/repos/a', homeDir })).toBe(
      resolveDataDir({ repoRoot: '/repos/a', homeDir }),
    );
  });

  it('uses a configured relative directory inside the project, with no hash', () => {
    expect(resolveDataDir({ repoRoot: '/repos/a', homeDir, configDir: '.diffity' })).toBe(
      '/repos/a/.diffity',
    );
  });

  it('uses a configured absolute directory as given', () => {
    expect(resolveDataDir({ repoRoot: '/repos/a', homeDir, configDir: '/srv/notes' })).toBe(
      '/srv/notes',
    );
  });

  it('lets the environment win over the repository config', () => {
    expect(
      resolveDataDir({ repoRoot: '/repos/a', homeDir, envDir: '/srv/env', configDir: '.diffity' }),
    ).toBe('/srv/env');
  });

  it('ignores blank values rather than resolving to the repository root', () => {
    expect(resolveDataDir({ repoRoot: '/repos/a', homeDir, envDir: '   ' })).toMatch(/\.diffity\//);
  });
});

describe('readRepoConfig', () => {
  it('reads dataDir', () => {
    writeFileSync(join(repoRoot, '.diffity.json'), JSON.stringify({ dataDir: '.notes' }));

    expect(readRepoConfig(repoRoot)).toEqual({ dataDir: '.notes' });
  });

  it('is empty when there is no config', () => {
    expect(readRepoConfig(repoRoot)).toEqual({});
  });

  it('survives malformed json rather than failing the review', () => {
    writeFileSync(join(repoRoot, '.diffity.json'), '{ not json');

    expect(readRepoConfig(repoRoot)).toEqual({});
  });

  it('ignores a dataDir of the wrong type', () => {
    writeFileSync(join(repoRoot, '.diffity.json'), JSON.stringify({ dataDir: 42 }));

    expect(readRepoConfig(repoRoot)).toEqual({});
  });

  it('ignores a directory instead of a config file', () => {
    mkdirSync(join(repoRoot, '.diffity.json'));

    expect(readRepoConfig(repoRoot)).toEqual({});
  });
});
