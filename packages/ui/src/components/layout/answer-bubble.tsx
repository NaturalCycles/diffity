import type { AnswerAlert } from '../../lib/answer-alerts';
import type { ThreadPosition } from '../../lib/thread-visibility';
import { XIcon } from '../icons/x-icon';

interface AnswerBubbleProps {
  alerts: AnswerAlert[];
  /** Which edge to sit on: the thread is behind the reader, or ahead of them. */
  position: ThreadPosition;
  onGo: (threadId: string) => void;
  onDismiss: () => void;
}

/**
 * An answer arrived and the thread it belongs to is off screen. Sits on the edge the thread is on,
 * so following it is a movement in the direction the bubble already suggests.
 *
 * Deliberately small and out of the way: a panel over the diff is worse than no panel, which the
 * walkthrough tooltip taught the hard way. Several answers collapse into one — two bubbles competing
 * for the same corner is worse than one that counts.
 */
export function AnswerBubble(props: AnswerBubbleProps) {
  const { alerts, position, onGo, onDismiss } = props;

  if (alerts.length === 0) {
    return null;
  }

  const newest = alerts[alerts.length - 1];
  const others = alerts.length - 1;
  const fileName = newest.filePath.split('/').pop() ?? newest.filePath;

  return (
    <div
      role="status"
      className={`absolute ${position === 'above' ? 'top-3' : 'bottom-3'} right-4 z-40 flex items-start gap-2 max-w-sm rounded-lg border px-3 py-2 shadow-md bg-note-bg border-note-border text-note-ink animate-slide-down`}
    >
      <button
        onClick={() => onGo(newest.threadId)}
        aria-label={newest.preview}
        className="min-w-0 flex-1 text-left cursor-pointer"
      >
        <span className="block text-[11px] font-semibold opacity-80">
          {newest.authorName} replied on {fileName}
          {others > 0 && <span className="font-normal"> · {others} more</span>}
        </span>
        <span className="block mt-0.5 text-xs whitespace-pre-line line-clamp-3">{newest.preview}</span>
      </button>
      <button
        onClick={onDismiss}
        aria-label="Dismiss"
        className="shrink-0 mt-0.5 opacity-60 hover:opacity-100 cursor-pointer"
      >
        <XIcon className="w-3 h-3" />
      </button>
    </div>
  );
}
