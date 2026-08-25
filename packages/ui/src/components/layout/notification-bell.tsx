import { useEffect, useRef, useState } from 'react';
import type { AnswerAlert } from '../../lib/answer-alerts';
import { BellIcon } from '../icons/bell-icon';

interface NotificationBellProps {
  alerts: AnswerAlert[];
  onGo: (threadId: string) => void;
}

export function NotificationBell(props: NotificationBellProps) {
  const { alerts, onGo } = props;
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) {
      return;
    }
    const closeOnOutside = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', closeOnOutside);
    return () => document.removeEventListener('mousedown', closeOnOutside);
  }, [open]);

  const label = alerts.length === 0
    ? 'No unread answers'
    : `${alerts.length} unread answer${alerts.length === 1 ? '' : 's'}`;

  return (
    <div ref={rootRef} className="relative">
      <button
        onClick={() => alerts.length > 0 && setOpen(prev => !prev)}
        aria-label={label}
        title={label}
        className={`relative flex items-center px-1.5 py-1 rounded-md transition-colors ${
          alerts.length > 0 ? 'text-text-secondary hover:bg-hover cursor-pointer' : 'text-text-muted/50'
        }`}
      >
        <BellIcon className="w-3.5 h-3.5" />
        {alerts.length > 0 && (
          <span className="absolute -top-0.5 -right-0.5 flex items-center justify-center min-w-3.5 h-3.5 px-1 rounded-full bg-deleted text-white text-[9px] font-semibold tabular-nums">
            {alerts.length}
          </span>
        )}
      </button>
      {open && (
        <div className="absolute right-0 top-full mt-1 z-50 w-80 max-h-80 overflow-y-auto rounded-md border border-border bg-bg shadow-md">
          {alerts.map(alert => (
            <button
              key={alert.threadId}
              role="menuitem"
              onClick={() => {
                setOpen(false);
                onGo(alert.threadId);
              }}
              className="w-full text-left px-3 py-2 border-b border-border-muted last:border-b-0 hover:bg-hover cursor-pointer"
            >
              <span className="block text-[11px] font-medium text-text-secondary">
                {alert.authorName} · {alert.filePath.split('/').pop()}
              </span>
              <span className="block mt-0.5 text-xs text-text line-clamp-2 whitespace-pre-line">
                {alert.preview}
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
