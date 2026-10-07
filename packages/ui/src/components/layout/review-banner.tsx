import dayjs from 'dayjs';
import relativeTime from 'dayjs/plugin/relativeTime';
import type { ReviewRun } from '../../lib/api';
import { Spinner } from '../icons/spinner';

dayjs.extend(relativeTime);

interface ReviewBannerProps {
  review: ReviewRun;
  findings: number;
  /** The review finished while this page was open, and the reader has not taken it in yet. */
  ready: boolean;
  onReload: () => void;
  /** An agent waits on this session or on the user's queue, so a review asked for now gets picked up. */
  agentListening?: boolean;
  onRequestReview?: () => void;
}

const BAR = 'flex items-center gap-2 px-4 py-2 border-b text-xs text-text';

/**
 * Deliberately loud while a review is under way: the difference between "nothing found" and "not
 * finished looking" is the difference between approving a change and approving it too early.
 */
export function ReviewBanner(props: ReviewBannerProps) {
  const { review, findings, ready, onReload, agentListening = false, onRequestReview } = props;
  const canRequest = agentListening && !!onRequestReview;
  const requestButton = (label: string) => (
    <button
      type="button"
      onClick={onRequestReview}
      className="px-2 py-0.5 rounded border border-accent/60 text-accent hover:bg-accent/15 cursor-pointer"
    >
      {label}
    </button>
  );

  if (review.state === 'queued') {
    return (
      <div role="status" data-testid="review-banner" data-state="queued" className={`${BAR} border-accent/40 bg-accent/10`}>
        <Spinner className="w-3.5 h-3.5 text-accent shrink-0" />
        <span className="font-medium">Queued for your agent</span>
        {review.queuedAt && <span className="text-text-secondary">since {dayjs(review.queuedAt).fromNow()}</span>}
      </div>
    );
  }

  if (review.state === 'claimed') {
    return (
      <div role="status" data-testid="review-banner" data-state="claimed" className={`${BAR} border-accent/40 bg-accent/10`}>
        <Spinner className="w-3.5 h-3.5 text-accent shrink-0" />
        <span className="font-medium">Your agent picked this up…</span>
        {review.queuedAt && <span className="text-text-secondary">queued {dayjs(review.queuedAt).fromNow()}</span>}
      </div>
    );
  }

  if (review.state === 'reviewing') {
    return (
      <div role="status" data-testid="review-banner" data-state="reviewing" className={`${BAR} border-accent/40 bg-accent/10`}>
        <Spinner className="w-3.5 h-3.5 text-accent shrink-0" />
        <span className="font-medium">Reviewing…</span>
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

  if (review.state === 'stale') {
    return (
      <div role="status" data-testid="review-banner" data-state="stale" className={`${BAR} border-border bg-bg-secondary`}>
        <span className="font-medium">No agent picked this up</span>
        <span className="text-text-secondary">
          Ask an agent to review it with the diffity <code>review</code> prompt, or to attend your queue.
        </span>
        {canRequest && <span className="ml-auto">{requestButton('Ask again')}</span>}
      </div>
    );
  }

  if (review.state === 'done' && ready) {
    return (
      <div role="status" data-testid="review-banner" data-state="ready" className={`${BAR} border-accent/40 bg-accent/10`}>
        <span className="font-medium">Review ready</span>
        <button
          type="button"
          onClick={onReload}
          className="px-2 py-0.5 rounded border border-accent/60 text-accent hover:bg-accent/15 cursor-pointer"
        >
          Reload
        </button>
      </div>
    );
  }

  if (canRequest && (review.state === 'none' || review.state === 'done')) {
    return (
      <div data-testid="review-banner" data-state={review.state} className={`${BAR} border-border bg-bg-secondary`}>
        <span className="text-text-secondary">An agent is listening.</span>
        {requestButton('Ask your agent to review')}
      </div>
    );
  }

  return null;
}
