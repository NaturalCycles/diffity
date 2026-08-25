import { useEffect, useRef, useState } from 'react';
import type { AnswerAlert } from '../../lib/answer-alerts';
import type { ThreadPosition } from '../../lib/thread-visibility';
import { XIcon } from '../icons/x-icon';

/** Long enough to read three lines and decide, short enough not to become furniture. */
export const SHOW_FOR_MS = 10_000;
const TICK_MS = 100;

interface AnswerBubbleProps {
  alerts: AnswerAlert[];
  /** Which edge to sit on: the thread is behind the reader, or ahead of them. */
  position: ThreadPosition;
  onGo: (threadId: string) => void;
  /** Its time ran out. The count that replaces it is the caller's business. */
  onExpire: () => void;
  onDismiss: () => void;
}

/**
 * An answer arrived and the thread it belongs to is off screen. Sits over the old side, near the
 * edge the thread is on, so following it moves the way the note already suggests — and never over
 * the new side, which is the code being reviewed.
 *
 * Leaves on its own, with a bar running down so that is not a surprise. Several answers collapse
 * into one: two notes competing for the same corner is worse than one that counts.
 */
export function AnswerBubble(props: AnswerBubbleProps) {
  const { alerts, position, onGo, onExpire, onDismiss } = props;
  const [remaining, setRemaining] = useState(1);
  const newest = alerts[alerts.length - 1];
  const expiredRef = useRef(false);

  useEffect(() => {
    if (!newest) {
      return;
    }
    expiredRef.current = false;
    setRemaining(1);
    const startedAt = Date.now();

    const timer = setInterval(() => {
      const left = 1 - (Date.now() - startedAt) / SHOW_FOR_MS;
      setRemaining(Math.max(0, left));
      if (left <= 0 && !expiredRef.current) {
        expiredRef.current = true;
        clearInterval(timer);
        onExpire();
      }
    }, TICK_MS);

    return () => clearInterval(timer);
    // Restarted by a newer answer arriving, not by every render.
  }, [newest?.threadId, newest?.preview, onExpire]);

  if (!newest) {
    return null;
  }

  const others = alerts.length - 1;
  const fileName = newest.filePath.split('/').pop() ?? newest.filePath;

  return (
    <div
      role="status"
      className={`absolute ${position === 'above' ? 'top-3' : 'bottom-3'} left-4 z-40 w-80 max-w-[40%] overflow-hidden rounded-lg border shadow-md bg-note-bg border-note-border text-note-ink animate-slide-down`}
    >
      <div className="flex items-start gap-2 px-3 py-2">
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
      <div
        data-testid="answer-bubble-timer"
        className="h-0.5 bg-note-ink/40"
        style={{ width: `${Math.round(remaining * 100)}%` }}
      />
    </div>
  );
}
