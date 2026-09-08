import type { ReviewEvent } from '@diffity/api';
import { inboxStorePath } from './paths.js';
import { InboxStore, prId } from './store.js';

/**
 * Notes that a review reached the forge, so the inbox keeps listing the pull request instead of
 * losing it the moment GitHub withdraws the review request.
 *
 * The store is opened and closed around the one write: this runs in whichever diffity posted the
 * review — a session the inbox prepared, or one the reviewer started on their own clone — and none
 * of those hold the inbox open otherwise.
 */
export function recordHandledReview(input: {
  owner: string;
  repo: string;
  number: number;
  /** The head the review was posted against. */
  headSha: string;
  event: ReviewEvent;
  reviewUrl: string | null;
  now: string;
  /** The reviewer's own inbox unless a test says otherwise. */
  storePath?: string;
}): void {
  const store = new InboxStore(input.storePath ?? inboxStorePath());
  try {
    store.recordHandled({
      prId: prId(input),
      headSha: input.headSha,
      event: input.event,
      reviewUrl: input.reviewUrl,
      at: input.now,
    });
  } finally {
    store.close();
  }
}
