export const REPO_CONFIG_FILE = '.diffity.json';

export const DEFAULT_SEVERITIES = ['P1', 'P2', 'P3'];

export interface ReviewConfig {
  /** Severity labels a reviewer should use, most severe first. */
  severities?: string[];
  /** Repository-relative path to the project's own review standards. */
  standards?: string;
}

/** The `review` section of a repository's `.diffity.json`; a malformed file reads as none. */
export function parseReviewConfig(text: string): ReviewConfig {
  let raw: unknown;
  try {
    raw = (JSON.parse(text) as { review?: unknown } | null)?.review;
  } catch {
    return {};
  }
  if (!raw || typeof raw !== 'object') {
    return {};
  }
  const { severities, standards } = raw as ReviewConfig;
  const review: ReviewConfig = {};
  if (Array.isArray(severities) && severities.length > 0 && severities.every(s => typeof s === 'string')) {
    review.severities = severities;
  }
  if (typeof standards === 'string' && standards) {
    review.standards = standards;
  }
  return review;
}
