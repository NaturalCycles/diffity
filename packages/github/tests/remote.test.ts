import { describe, it, expect } from 'vitest';
import { parseRemoteUrl, isSafeRepoName } from '../src/remote.js';

describe('parseRemoteUrl', () => {
  it('reads ssh and https forms', () => {
    expect(parseRemoteUrl('git@github.com:NaturalCycles/diffity.git')).toEqual({
      owner: 'NaturalCycles',
      repo: 'diffity',
    });
    expect(parseRemoteUrl('https://github.com/NaturalCycles/diffity.git')).toEqual({
      owner: 'NaturalCycles',
      repo: 'diffity',
    });
    expect(parseRemoteUrl('https://github.com/NaturalCycles/diffity')).toEqual({
      owner: 'NaturalCycles',
      repo: 'diffity',
    });
  });

  it('refuses a host that merely contains github.com', () => {
    // An unanchored match made `https://attacker.net/github.com/evil/repo` parse as evil/repo.
    expect(parseRemoteUrl('https://attacker.net/github.com/evil/repo')).toBeNull();
    expect(parseRemoteUrl('https://github.com.attacker.net/evil/repo')).toBeNull();
  });

  it('refuses a name that could not be a repository', () => {
    expect(parseRemoteUrl('https://github.com/$(touch PWNED)/repo')).toBeNull();
    expect(parseRemoteUrl('git@github.com:owner/$(id).git')).toBeNull();
    expect(parseRemoteUrl('https://github.com/own er/repo')).toBeNull();
  });

  it('refuses anything that is not a remote url', () => {
    expect(parseRemoteUrl('')).toBeNull();
    expect(parseRemoteUrl('not a url')).toBeNull();
    expect(parseRemoteUrl('https://gitlab.com/owner/repo')).toBeNull();
  });
});

describe('isSafeRepoName', () => {
  it('accepts what GitHub allows', () => {
    for (const name of ['NaturalCycles', 'diffity', 'my-repo', 'my_repo', 'v1.0', 'a']) {
      expect(isSafeRepoName(name), name).toBe(true);
    }
  });

  it('rejects shell metacharacters and whitespace', () => {
    for (const name of ['$(id)', '`id`', 'a;b', 'a b', 'a/b', '', '..']) {
      expect(isSafeRepoName(name), name).toBe(false);
    }
  });
});
