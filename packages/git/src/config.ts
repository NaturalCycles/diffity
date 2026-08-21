import { readFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { isAbsolute, join, resolve } from 'node:path';

export const REPO_CONFIG_FILE = '.diffity.json';

export interface ReviewConfig {
  /** Severity labels a reviewer should use, most severe first. */
  severities?: string[];
  /**
   * Repository-relative path to the project's own review standards, for an agent to read
   * before reviewing. Keeping them in the repository means they are versioned with the code
   * and shared by everyone, rather than living in one person's agent configuration.
   */
  standards?: string;
}

export interface RepoConfig {
  /**
   * Where review threads, walkthroughs and sessions are kept. Relative paths resolve against
   * the repository root, so a project can keep its review notes with itself.
   */
  dataDir?: string;
  review?: ReviewConfig;
}

export const DEFAULT_SEVERITIES = ['P1', 'P2', 'P3'];

export function readRepoConfig(repoRoot: string): RepoConfig {
  const path = join(repoRoot, REPO_CONFIG_FILE);
  if (!existsSync(path)) {
    return {};
  }

  try {
    const parsed = JSON.parse(readFileSync(path, 'utf-8')) as RepoConfig;
    const config: RepoConfig = {};

    if (typeof parsed?.dataDir === 'string') {
      config.dataDir = parsed.dataDir;
    }

    const review = readReviewConfig(parsed?.review);
    if (review) {
      config.review = review;
    }

    return config;
  } catch {
    // A malformed config must not stop a review; the default is always usable.
    return {};
  }
}

function readReviewConfig(raw: unknown): ReviewConfig | undefined {
  if (!raw || typeof raw !== 'object') {
    return undefined;
  }

  const { severities, standards } = raw as ReviewConfig;
  const review: ReviewConfig = {};

  if (Array.isArray(severities) && severities.every(s => typeof s === 'string') && severities.length > 0) {
    review.severities = severities;
  }
  if (typeof standards === 'string' && standards) {
    review.standards = standards;
  }

  return Object.keys(review).length > 0 ? review : undefined;
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
