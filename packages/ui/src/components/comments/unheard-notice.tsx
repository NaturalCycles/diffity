import { useEffect } from 'react';

const SHOW_FOR_MS = 5_000;

/**
 * Sits over the thread just long enough to be read, because the moment of pressing is when the
 * reader decides their question was sent. A tooltip on the button says the same thing and goes
 * unread — nobody hovers a button before pressing it.
 */
export function UnheardNotice(props: { title: string; description: string; onDone: () => void }) {
  const { title, description, onDone } = props;

  useEffect(() => {
    const timer = setTimeout(onDone, SHOW_FOR_MS);
    return () => clearTimeout(timer);
  }, [onDone]);

  return (
    <div
      className="absolute inset-x-0 top-1/2 -translate-y-1/2 z-30 flex justify-center px-4 pointer-events-none"
      data-testid="unheard-notice"
      role="status"
    >
      <div className="pointer-events-auto max-w-sm rounded-lg border border-modified/50 bg-bg-secondary/95 px-3 py-2 shadow-lg backdrop-blur-sm">
        <div className="text-xs font-medium text-modified">{title}</div>
        <div className="text-[11px] text-text-secondary mt-0.5">{description}</div>
        <button
          onClick={onDone}
          className="text-[10px] text-text-muted hover:text-text-secondary mt-1 cursor-pointer"
        >
          Dismiss
        </button>
      </div>
    </div>
  );
}
