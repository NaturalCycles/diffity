import { execFileSync } from 'node:child_process';
import type { PrReview } from './types.js';

interface RawReview {
  user?: { login?: string; type?: string };
  state?: string;
  body?: string;
  submitted_at?: string;
}

/**
 * A review with no body and no verdict has nothing a reader can act on — the forge records one of
 * those for a batch of inline comments, and those arrive through the inline pull instead.
 */
function isWorthShowing(review: PrReview): boolean {
  return review.body.trim().length > 0 || review.state !== 'COMMENTED';
}

export function parseReviews(json: string): PrReview[] {
  let data: unknown;
  try {
    data = JSON.parse(json);
  } catch {
    return [];
  }

  if (!Array.isArray(data)) {
    return [];
  }

  return (data as RawReview[])
    .map(review => ({
      author: review.user?.login ?? 'unknown',
      isBot: review.user?.type === 'Bot',
      state: review.state ?? 'COMMENTED',
      body: review.body ?? '',
      submittedAt: review.submitted_at ?? '',
    }))
    .filter(isWorthShowing);
}

export function getReviews(owner: string, repo: string, prNumber: number): PrReview[] {
  try {
    return parseReviews(
      execFileSync(
        'gh',
        ['api', `repos/${owner}/${repo}/pulls/${prNumber}/reviews`, '--paginate'],
        { encoding: 'utf-8', stdio: 'pipe', maxBuffer: 10 * 1024 * 1024 },
      ),
    );
  } catch {
    return [];
  }
}
