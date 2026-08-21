import dayjs from 'dayjs';
import relativeTime from 'dayjs/plugin/relativeTime';
import type { ReviewRun } from '../../lib/api';
import { Spinner } from '../icons/spinner';

dayjs.extend(relativeTime);

interface ReviewProgressBannerProps {
  review: ReviewRun;
  findings: number;
}

/**
 * Deliberately loud: the difference between "nothing found" and "not finished looking" is the
 * difference between approving a change and approving it too early.
 */
export function ReviewProgressBanner(props: ReviewProgressBannerProps) {
  const { review, findings } = props;

  return (
    <div
      role="status"
      data-testid="review-in-progress"
      className="flex items-center gap-2 px-4 py-2 border-b border-accent/40 bg-accent/10 text-xs text-text"
    >
      <Spinner className="w-3.5 h-3.5 text-accent shrink-0" />
      <span className="font-medium">A review is still in progress</span>
      <span className="text-text-secondary">
        {findings === 0
          ? 'no findings yet'
          : `${findings} finding${findings === 1 ? '' : 's'} so far`}
        {review.startedAt ? ` · started ${dayjs(review.startedAt).fromNow()}` : ''}
        {review.note ? ` · ${review.note}` : ''}
      </span>
      <span className="ml-auto text-text-muted">Wait for it to finish before approving.</span>
    </div>
  );
}
