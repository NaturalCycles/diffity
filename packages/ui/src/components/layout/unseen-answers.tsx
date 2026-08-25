import type { AnswerAlert } from '../../lib/answer-alerts';
import { ArrowUpIcon } from '../icons/arrow-up-icon';

interface UnseenAnswersProps {
  alerts: AnswerAlert[];
  onGo: (threadId: string) => void;
}

/** What a note leaves behind once its time is up. Goes to the oldest first. */
export function UnseenAnswers(props: UnseenAnswersProps) {
  const { alerts, onGo } = props;

  if (alerts.length === 0) {
    return null;
  }

  const oldest = alerts[0];

  return (
    <button
      onClick={() => onGo(oldest.threadId)}
      title={`${alerts.length} answer${alerts.length === 1 ? '' : 's'} you have not read — go to the first`}
      className="absolute left-24 -top-3 z-40 flex items-center gap-1 rounded-full border border-border bg-bg-secondary pl-1 pr-1.5 py-0.5 shadow-md hover:bg-hover cursor-pointer"
    >
      <span className="flex items-center justify-center min-w-4 h-4 px-1 rounded-full bg-deleted text-white text-[10px] font-semibold tabular-nums">
        {alerts.length}
      </span>
      <span className="text-text-secondary">
        <ArrowUpIcon />
      </span>
    </button>
  );
}
