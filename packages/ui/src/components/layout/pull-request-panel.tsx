import { useState } from 'react';
import dayjs from 'dayjs';
import relativeTime from 'dayjs/plugin/relativeTime';
import type { GitHubDetails } from '../../lib/api';
import { MarkdownContent } from './markdown-content';
import { ChevronDownIcon } from '../icons/chevron-down-icon';
import { ChevronUpIcon } from '../icons/chevron-up-icon';

dayjs.extend(relativeTime);

interface PullRequestPanelProps {
  details: GitHubDetails | null;
}

function stateClass(state: string): string {
  if (state === 'APPROVED') {
    return 'text-added';
  }
  if (state === 'CHANGES_REQUESTED') {
    return 'text-deleted';
  }
  return 'text-text-muted';
}

/**
 * What the author says the change is for, and what other reviewers have already said. Reading a
 * diff without either means re-deriving the intent from the code, and repeating a point someone
 * else has already made.
 */
export function PullRequestPanel(props: PullRequestPanelProps) {
  const { details } = props;
  const [open, setOpen] = useState(true);

  if (!details) {
    return null;
  }

  const { prBody, reviews } = details;

  return (
    <div className="border-b border-border bg-bg-secondary">
      <button
        className="w-full flex items-center gap-2 px-4 py-2 text-xs text-text-secondary hover:text-text cursor-pointer"
        onClick={() => setOpen(prev => !prev)}
        aria-expanded={open}
      >
        {open ? <ChevronUpIcon className="w-3.5 h-3.5" /> : <ChevronDownIcon className="w-3.5 h-3.5" />}
        <span className="font-medium uppercase tracking-wider">Pull request</span>
        {reviews.length > 0 && (
          <span className="text-text-muted">
            {reviews.length} existing review{reviews.length === 1 ? '' : 's'}
          </span>
        )}
      </button>

      {open && (
        <div className="px-4 pb-3 space-y-3">
          <div className="text-xs text-text-secondary max-h-64 overflow-y-auto">
            {prBody.trim() ? (
              <MarkdownContent content={prBody} />
            ) : (
              <span className="italic text-text-muted">No description on the pull request.</span>
            )}
          </div>

          {reviews.map((review, index) => (
            <div key={`${review.author}-${index}`} className="border-t border-border pt-2">
              <div className="flex items-center gap-2 text-[11px] mb-1">
                <span className="font-medium text-text">{review.author}</span>
                {review.isBot && (
                  <span className="px-1 rounded bg-bg-tertiary text-[9px] text-text-muted">bot</span>
                )}
                <span className={`font-medium ${stateClass(review.state)}`}>{review.state}</span>
                {review.submittedAt && (
                  <span className="text-text-muted">{dayjs(review.submittedAt).fromNow()}</span>
                )}
              </div>
              {review.body.trim() && (
                <div className="text-xs text-text-secondary max-h-48 overflow-y-auto">
                  <MarkdownContent content={review.body} />
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
