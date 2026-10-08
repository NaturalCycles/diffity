import { alertLabel, type AnswerAlert } from '../../lib/answer-alerts';
import { GENERAL_THREAD_FILE_PATH } from '../comments/types';
import { XIcon } from '../icons/x-icon';

interface AnswerBubbleProps {
  alerts: AnswerAlert[];
  onGo: (alert: AnswerAlert) => void;
  onDismiss: () => void;
}

/** Bottom left, over the old side in split view rather than the code under review. */
export function AnswerBubble(props: AnswerBubbleProps) {
  const { alerts, onGo, onDismiss } = props;
  if (alerts.length === 0) {
    return null;
  }

  return (
    <div
      role="status"
      className="absolute bottom-4 left-4 z-40 flex items-start gap-2 max-w-[40%] rounded-lg border shadow-md px-3 py-2 bg-note-bg border-note-border text-note-text"
    >
      <ul className="min-w-0 flex-1 space-y-0.5">
        {alerts.map(alert => (
          <li key={alert.threadId}>
            <button
              onClick={() => onGo(alert)}
              title={alert.filePath === GENERAL_THREAD_FILE_PATH ? undefined : `${alert.filePath}:${alert.startLine}`}
              className="block max-w-full truncate text-left text-xs cursor-pointer hover:underline"
            >
              <span className="font-semibold">Agent answered</span> · {alertLabel(alert)}
            </button>
          </li>
        ))}
      </ul>
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
