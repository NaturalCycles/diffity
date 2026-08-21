import type { GitHubRemote } from './types.js';

/**
 * What GitHub permits in an owner or repository name. Everything reaching a `gh` argument is
 * checked against this: the names come from a remote URL, and a submodule's `.gitmodules` is
 * attacker-controlled in a pull request.
 */
const SAFE_NAME = /^[A-Za-z0-9._-]+$/;

export function isSafeRepoName(name: string): boolean {
  return name !== '.' && name !== '..' && SAFE_NAME.test(name);
}

/**
 * Parses a GitHub remote URL. The host is compared exactly rather than searched for, so
 * `https://attacker.net/github.com/evil/repo` is not read as `evil/repo`.
 */
export function parseRemoteUrl(url: string): GitHubRemote | null {
  const trimmed = url.trim();
  if (!trimmed) {
    return null;
  }

  const ssh = /^(?:ssh:\/\/)?(?:git@)?github\.com[:/]([^/]+)\/(.+?)(?:\.git)?$/.exec(trimmed);
  const viaUrl = tryUrl(trimmed);
  const parts = viaUrl ?? (ssh ? [ssh[1], ssh[2]] : null);

  if (!parts) {
    return null;
  }

  const [owner, repo] = parts;
  if (!isSafeRepoName(owner) || !isSafeRepoName(repo)) {
    return null;
  }

  return { owner, repo };
}

function tryUrl(value: string): [string, string] | null {
  if (!/^https?:\/\//.test(value)) {
    return null;
  }

  try {
    const parsed = new URL(value);
    if (parsed.hostname !== 'github.com') {
      return null;
    }
    const segments = parsed.pathname.split('/').filter(Boolean);
    if (segments.length < 2) {
      return null;
    }
    return [segments[0], segments[1].replace(/\.git$/, '')];
  } catch {
    return null;
  }
}
