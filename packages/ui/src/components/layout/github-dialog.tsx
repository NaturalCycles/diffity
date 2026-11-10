import { useState, useEffect, useMemo } from 'react';
import dayjs from 'dayjs';
import relativeTime from 'dayjs/plugin/relativeTime';
import { toast } from 'sonner';
import { GitHubIcon } from '../icons/github-icon';
import { UploadIcon } from '../icons/upload-icon';
import { DownloadIcon } from '../icons/download-icon';
import { XIcon } from '../icons/x-icon';
import {
  createReviewOnGitHub,
  MovedOnError,
  pullCommentsFromGitHub,
  type GitHubDetails,
  type ReviewEvent,
} from '../../lib/api';
import { advanceAndGo, saveReviewDraft, takeReviewDraft } from '../../lib/session-head';
import type { CommentThread } from '../comments/types';
import {
  canSubmitReview,
  isSubmittable,
  movedOnNote,
  wasSubmitted,
  summaryFromGeneralThreads,
  threadToPayload,
} from '../../lib/review-submission';
import { pullOutcome } from '../../lib/pull-outcome';

dayjs.extend(relativeTime);

interface GitHubDialogProps {
  details: GitHubDetails;
  threads: CommentThread[];
  sessionId: string | null;
  /** An agent is still writing findings, so the review is not ready to post. */
  reviewInProgress?: boolean;
  onPulled: () => void;
  onClose: () => void;
}

const EVENT_LABELS: Record<ReviewEvent, string> = {
  COMMENT: 'Comment',
  APPROVE: 'Approve',
  REQUEST_CHANGES: 'Request changes',
};

function lineLabel(thread: CommentThread): string {
  return thread.startLine === thread.endLine
    ? `${thread.startLine}`
    : `${thread.startLine}-${thread.endLine}`;
}

export function GitHubDialog(props: GitHubDialogProps) {
  const { details, threads, sessionId, reviewInProgress, onPulled, onClose } = props;
  const [commentCount, setCommentCount] = useState(details.commentCount);
  const [submitting, setSubmitting] = useState(false);
  const [pulling, setPulling] = useState(false);
  const [draft] = useState(() => (sessionId ? takeReviewDraft(sessionId) : null));
  const [event, setEvent] = useState<ReviewEvent>(draft?.event ?? 'COMMENT');

  const submittable = useMemo(() => threads.filter(isSubmittable), [threads]);
  const [selected, setSelected] = useState<Set<string>>(() => new Set(draft?.deselected.map(id => `-${id}`)));
  const [summary, setSummary] = useState(draft?.summary ?? '');
  const [summaryEdited, setSummaryEdited] = useState(draft?.summary != null);
  /** The pull request's head, when posting found it had moved on since this session's. */
  const [movedTo, setMovedTo] = useState<string | null>(null);
  const [updating, setUpdating] = useState(false);

  // Everything open is selected by default, including threads arriving from the agent while
  // the dialog is open; deselecting is the deliberate act.
  useEffect(() => {
    setSelected(prev => {
      const next = new Set(prev);
      for (const thread of submittable) {
        if (!prev.has(`-${thread.id}`) && !wasSubmitted(thread)) {
          next.add(thread.id);
        }
      }
      return next;
    });
  }, [submittable]);

  useEffect(() => {
    if (!summaryEdited) {
      setSummary(summaryFromGeneralThreads(threads));
    }
  }, [threads, summaryEdited]);

  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose();
      }
    };
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [onClose]);

  const chosen = submittable.filter(thread => selected.has(thread.id));
  const canSubmit = canSubmitReview({
    event,
    comments: chosen.length,
    summary,
    reviewInProgress,
  });

  const toggle = (id: string) => {
    setSelected(prev => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
        // Remembered so the default-select effect does not re-add it.
        next.add(`-${id}`);
      } else {
        next.delete(`-${id}`);
        next.add(id);
      }
      return next;
    });
  };

  const toggleAll = () => {
    if (chosen.length === submittable.length) {
      setSelected(new Set(submittable.map(thread => `-${thread.id}`)));
      return;
    }
    setSelected(new Set(submittable.map(thread => thread.id)));
  };

  const handleSubmit = async (allowOutdated = false) => {
    if (!canSubmit) {
      return;
    }
    setSubmitting(true);
    try {
      const result = await createReviewOnGitHub({
        event,
        body: summary,
        comments: chosen.map(threadToPayload),
        ...(allowOutdated ? { allowOutdated } : {}),
      });

      if (result.failed > 0) {
        toast.error(`Review not submitted — ${result.failed} comment${result.failed !== 1 ? 's' : ''} rejected`, {
          description: result.errors.join('\n'),
        });
      } else {
        const skipped = result.skipped > 0 ? ` (${result.skipped} already on the PR)` : '';
        const moved = movedOnNote({ commitSha: result.commitSha, headSha: movedTo ?? details.headSha });
        toast.success(
          `Submitted ${result.submitted} comment${result.submitted !== 1 ? 's' : ''} as one review${skipped}`,
          moved ? { description: moved } : undefined,
        );
        setCommentCount(prev => prev + result.submitted);
        onClose();
      }
    } catch (err) {
      if (err instanceof MovedOnError) {
        setMovedTo(err.headSha);
        return;
      }
      toast.error('Failed to submit review', {
        description: err instanceof Error ? err.message : 'Unknown error',
      });
    } finally {
      setSubmitting(false);
    }
  };

  const handleUpdate = async () => {
    if (!sessionId) {
      return;
    }
    setUpdating(true);
    try {
      const left = await advanceAndGo(sessionId, next => saveReviewDraft(next, {
        summary: summaryEdited ? summary : null,
        event,
        deselected: submittable.filter(thread => !selected.has(thread.id)).map(thread => thread.id),
      }));
      if (!left) {
        setUpdating(false);
        setMovedTo(null);
      }
    } catch (err) {
      setUpdating(false);
      toast.error('Could not update to the pull request’s current head', {
        description: err instanceof Error ? err.message : 'Unknown error',
      });
    }
  };

  const handlePull = async () => {
    if (!sessionId || commentCount === 0) {
      return;
    }
    setPulling(true);
    try {
      const result = await pullCommentsFromGitHub(sessionId);
      const outcome = pullOutcome(result);
      toast[outcome.kind](outcome.message);
      if (outcome.refresh) {
        onPulled();
      }
    } catch (err) {
      toast.error('Failed to pull comments', {
        description: err instanceof Error ? err.message : 'Unknown error',
      });
    } finally {
      setPulling(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onClick={onClose}>
      <div
        role="dialog"
        aria-label="Post to GitHub"
        data-post-dialog
        className="bg-bg rounded-xl shadow-lg w-full max-w-lg mx-4 font-sans max-h-[85vh] flex flex-col"
        onClick={e => e.stopPropagation()}
      >
        <div className="flex items-start justify-between px-4 pt-4 pb-2">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2 mb-1">
              <GitHubIcon className="w-4 h-4 text-text shrink-0" />
              <span className="text-sm font-semibold text-text truncate">{details.prTitle}</span>
            </div>
            <div className="flex items-center gap-1.5 text-[11px] text-text-muted pl-6">
              <span>#{details.prNumber}</span>
              <span>&middot;</span>
              <span>opened {dayjs(details.prCreatedAt).fromNow()}</span>
            </div>
          </div>
          <button
            onClick={onClose}
            className="p-1 rounded-md text-text-muted hover:text-text hover:bg-hover transition-colors cursor-pointer shrink-0 mt-0.5"
          >
            <XIcon className="w-3.5 h-3.5" />
          </button>
        </div>

        <div className="px-4 pb-4 pt-2 space-y-3 overflow-y-auto">
          <div>
            <div className="flex items-center justify-between mb-1.5">
              <span className="text-[11px] font-medium uppercase tracking-wider text-text-secondary">
                Summary
              </span>
              <span className="text-[11px] text-text-muted">Markdown</span>
            </div>
            <textarea
              className="w-full h-20 px-2.5 py-2 border border-border rounded-md bg-bg text-xs outline-none focus:border-accent focus:ring-1 focus:ring-accent/20 resize-y placeholder:text-text-muted"
              placeholder="What the reviewer should take away. General comments land here."
              value={summary}
              onChange={e => {
                setSummary(e.target.value);
                setSummaryEdited(true);
              }}
            />
          </div>

          <div>
            <div className="flex items-center justify-between mb-1.5">
              <span className="text-[11px] font-medium uppercase tracking-wider text-text-secondary">
                Comments
              </span>
              {submittable.length > 0 && (
                <button
                  className="text-[11px] text-accent hover:underline cursor-pointer"
                  onClick={toggleAll}
                >
                  {chosen.length === submittable.length ? 'Deselect all' : 'Select all'}
                </button>
              )}
            </div>
            {submittable.length === 0 ? (
              <div className="text-xs text-text-muted py-2">
                No open comments. A summary on its own still makes a review.
              </div>
            ) : (
              <ul className="border border-border rounded-md divide-y divide-border max-h-56 overflow-y-auto">
                {submittable.map(thread => (
                  <li key={thread.id} className="flex gap-2 px-2.5 py-2">
                    <input
                      type="checkbox"
                      checked={selected.has(thread.id)}
                      onChange={() => toggle(thread.id)}
                      className="accent-accent cursor-pointer w-3 h-3 mt-0.5 shrink-0"
                      aria-label={`Include ${thread.filePath}:${lineLabel(thread)}`}
                    />
                    <button
                      className="min-w-0 flex-1 text-left cursor-pointer"
                      onClick={() => toggle(thread.id)}
                    >
                      <div className="flex items-baseline gap-1.5">
                        <span className="text-[11px] font-medium text-text truncate">
                          {thread.filePath}
                        </span>
                        <span className="text-[11px] text-text-muted tabular-nums shrink-0">
                          {lineLabel(thread)}
                        </span>
                        {wasSubmitted(thread) && (
                          <span className="text-[10px] text-text-muted shrink-0">
                            already on the pull request
                          </span>
                        )}
                        {thread.comments.length > 1 && (
                          <span className="text-[10px] text-text-muted shrink-0">
                            +{thread.comments.length - 1} repl{thread.comments.length === 2 ? 'y' : 'ies'} · not sent
                          </span>
                        )}
                      </div>
                      <div className="text-[11px] text-text-secondary line-clamp-2">
                        {thread.comments[0]?.body}
                      </div>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>

          {reviewInProgress && (
            <div className="flex items-center gap-2 px-2.5 py-2 rounded-md border border-accent/40 bg-accent/10 text-[11px] text-text">
              A review is still in progress — more findings may arrive. Wait for it to finish
              before submitting.
            </div>
          )}

          {movedTo ? (
            <div
              role="alertdialog"
              aria-label="The pull request has moved on"
              data-testid="moved-on-confirm"
              className="space-y-2 px-2.5 py-2 rounded-md border border-accent/40 bg-accent/10 text-[11px] text-text"
            >
              <div>
                The pull request has moved on to <code>{movedTo.slice(0, 7)}</code> since{' '}
                <code>{details.headSha.slice(0, 7)}</code>, the commit you reviewed. Update to see the new code; open
                findings and this draft come along. Or post to the reviewed commit, where GitHub marks lines changed
                since as outdated.
              </div>
              <div className="flex items-center gap-2 justify-end">
                <button
                  type="button"
                  onClick={() => void handleSubmit(true)}
                  disabled={submitting || updating || !canSubmit}
                  className="px-3 py-1.5 text-xs font-medium rounded-md border border-border bg-bg hover:bg-hover text-text-secondary cursor-pointer disabled:opacity-50"
                >
                  Post to {details.headSha.slice(0, 7)} anyway
                </button>
                <button
                  type="button"
                  onClick={() => void handleUpdate()}
                  disabled={submitting || updating || !sessionId}
                  className="px-3 py-1.5 text-xs font-medium rounded-md bg-accent text-white hover:bg-accent-hover cursor-pointer disabled:opacity-50"
                >
                  Update to {movedTo.slice(0, 7)}
                </button>
              </div>
            </div>
          ) : (
            <div className="flex items-center gap-2">
              <div className="flex items-center gap-1 flex-1">
                {(Object.keys(EVENT_LABELS) as ReviewEvent[]).map(value => {
                  const blocked = value !== 'COMMENT' && details.viewerDidAuthor;
                  return (
                    <button
                      key={value}
                      className={`px-2 py-1 text-[11px] rounded-md border cursor-pointer disabled:cursor-not-allowed disabled:opacity-40 ${
                        event === value
                          ? 'border-accent bg-accent/10 text-accent'
                          : 'border-border bg-bg hover:bg-hover text-text-secondary'
                      }`}
                      onClick={() => setEvent(value)}
                      disabled={blocked}
                      title={blocked ? 'GitHub does not allow this on your own pull request' : undefined}
                      aria-pressed={event === value}
                    >
                      {EVENT_LABELS[value]}
                    </button>
                  );
                })}
              </div>
              <button
                onClick={() => void handleSubmit()}
                disabled={submitting || !canSubmit}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-md bg-accent text-white hover:bg-accent-hover transition-colors cursor-pointer disabled:opacity-50 shrink-0"
              >
                {submitting ? (
                  <span className="w-3 h-3 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                ) : (
                  <UploadIcon className="w-3 h-3" />
                )}
                {chosen.length > 0
                  ? `Submit ${chosen.length} as one review`
                  : event === 'COMMENT'
                    ? 'Submit as one review'
                    : `Submit ${EVENT_LABELS[event].toLowerCase()}`}
              </button>
            </div>
          )}

          <div className="flex items-center justify-between py-2.5 px-3 bg-bg-secondary rounded-lg">
            <div>
              <div className="text-xs font-medium text-text">
                {commentCount} comment{commentCount !== 1 ? 's' : ''} on GitHub
              </div>
              <div className="text-[11px] text-text-muted mt-0.5">Review comments on the PR</div>
            </div>
            {commentCount > 0 && sessionId && (
              <button
                onClick={handlePull}
                disabled={pulling}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-md bg-bg-tertiary text-text-secondary hover:text-text transition-colors cursor-pointer disabled:opacity-50 shrink-0"
              >
                {pulling ? (
                  <span className="w-3 h-3 border-2 border-text-muted/30 border-t-text-muted rounded-full animate-spin" />
                ) : (
                  <DownloadIcon className="w-3 h-3" />
                )}
                Pull from PR
              </button>
            )}
          </div>

          <a
            href={details.prUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center justify-center gap-1.5 w-full py-2 text-xs text-text-muted hover:text-text transition-colors"
          >
            Open on GitHub
            <svg className="w-3 h-3" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
              <path d="M6 3h7v7" />
              <path d="M13 3L6 10" />
            </svg>
          </a>
        </div>
      </div>
    </div>
  );
}
