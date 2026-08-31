import { useState } from 'react';
import type { CommentThread as CommentThreadType } from './types';
import { isThreadResolved } from './types';
import { submittedLabel } from '../../lib/submitted-marker';
import { unheardNote } from '../../lib/unheard-request';
import { UnheardNotice } from './unheard-notice';
import { CommentBubble } from './comment-bubble';
import { CommentForm } from './comment-form';
import { TrashIcon } from '../icons/trash-icon';
import { cn } from '../../lib/cn';

interface ThreadCardProps {
  thread: CommentThreadType;
  onEditComment: (commentId: string, body: string) => void;
  onDeleteComment: (commentId: string) => void;
  onDeleteThread: () => void;
  onReply?: (body: string) => void;
  /** Hands the reply to the agent as a question. Absent when no agent can be reached. */
  onAskReply?: (body: string) => void;
  /** Asks the agent to make the change. Absent when the code is not the reader's to change. */
  onActReply?: (body: string) => void;
  askIsHeard?: boolean;
  onResolve?: () => void;
  onUnresolve?: () => void;
  headerLeft?: React.ReactNode;
  headerRight?: React.ReactNode;
  className?: string;
  children?: React.ReactNode;
}

export function ThreadCard(props: ThreadCardProps) {
  const {
    thread,
    onEditComment,
    onDeleteComment,
    onDeleteThread,
    onReply,
    onResolve,
    onUnresolve,
    headerLeft,
    headerRight,
    className,
    children,
    onAskReply,
    onActReply,
    askIsHeard,
  } = props;
  const [showReply, setShowReply] = useState(false);
  const [unheard, setUnheard] = useState<{ title: string; description: string } | null>(null);
  const resolved = isThreadResolved(thread);
  const sentLabel = submittedLabel(thread.submittedAt);

  return (
    <div className={cn('relative rounded-lg overflow-hidden', className)} data-thread-id={thread.id}>
      {unheard && (
        <UnheardNotice
          title={unheard.title}
          description={unheard.description}
          onDone={() => setUnheard(null)}
        />
      )}
      <div className="flex items-center justify-between px-3 pt-2.5 pb-1.5">
        <div className="flex items-center gap-2">
          {headerLeft}
          {sentLabel && (
            <span className="text-[10px] text-text-muted shrink-0" data-testid="submitted-marker">
              {sentLabel}
            </span>
          )}
        </div>
        <div className="flex items-center gap-1">
          {onResolve && onUnresolve && (
            resolved ? (
              <button
                onClick={onUnresolve}
                className="text-[11px] text-text-muted hover:text-text-secondary transition-colors cursor-pointer"
              >
                Reopen
              </button>
            ) : (
              <button
                onClick={onResolve}
                className="text-[11px] text-text-muted hover:text-text-secondary transition-colors cursor-pointer"
              >
                Resolve
              </button>
            )
          )}
          {headerRight}
          <button
            onClick={onDeleteThread}
            className="text-text-muted hover:text-deleted transition-colors cursor-pointer ml-1"
            title="Delete thread"
          >
            <TrashIcon className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>
      {children}
      <div className="px-1.5">
        {thread.comments.map((comment) => (
          <CommentBubble
            key={comment.id}
            comment={comment}
            onEdit={(body) => onEditComment(comment.id, body)}
            onDelete={() => onDeleteComment(comment.id)}
          />
        ))}
      </div>
      {onReply && (
        showReply ? (
          <div className="px-3 pb-2">
            <CommentForm
              onSubmit={(body) => {
                onReply(body);
                setShowReply(false);
              }}
              onAsk={onAskReply && ((body) => {
                onAskReply(body);
                setUnheard(unheardNote('ask', askIsHeard !== false));
                setShowReply(false);
              })}
              onAct={onActReply && ((body) => {
                onActReply(body);
                setUnheard(unheardNote('act', askIsHeard !== false));
                setShowReply(false);
              })}
              askIsHeard={askIsHeard}
              onCancel={() => setShowReply(false)}
              placeholder="Reply..."
              submitLabel="Reply"
            />
          </div>
        ) : (
          <div className="px-4 pb-2">
            <button
              onClick={() => setShowReply(true)}
              className="text-xs text-accent hover:text-accent-hover transition-colors cursor-pointer"
            >
              Reply
            </button>
          </div>
        )
      )}
    </div>
  );
}
