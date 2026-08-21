import { readFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { isAbsolute, join, resolve } from 'node:path';

export const REPO_CONFIG_FILE = '.diffity.json';

export interface RepoConfig {
  /**
   * Where review threads, walkthroughs and sessions are kept. Relative paths resolve against
   * the repository root, so a project can keep its review notes with itself.
   */
  dataDir?: string;
}

export function readRepoConfig(repoRoot: string): RepoConfig {
  const path = join(repoRoot, REPO_CONFIG_FILE);
  if (!existsSync(path)) {
    return {};
  }

  try {
    const parsed = JSON.parse(readFileSync(path, 'utf-8')) as RepoConfig;
    return typeof parsed?.dataDir === 'string' ? { dataDir: parsed.dataDir } : {};
  } catch {
    // A malformed config must not stop a review; the default is always usable.
    return {};
  }
}

/**
 * The hashed subdirectory only exists to keep repositories apart inside the shared default
 * location. A data directory chosen for one project needs no such disambiguation, so it is
 * used as given — `.diffity/reviews.db` rather than `.diffity/<hash>/reviews.db`.
 */
export function resolveDataDir(input: {
  repoRoot: string;
  homeDir: string;
  envDir?: string;
  configDir?: string;
}): string {
  const chosen = input.envDir?.trim() || input.configDir?.trim();

  if (chosen) {
    return isAbsolute(chosen) ? chosen : resolve(input.repoRoot, chosen);
  }

  const hash = createHash('sha256').update(input.repoRoot).digest('hex').slice(0, 12);
  return join(input.homeDir, '.diffity', hash);
}
