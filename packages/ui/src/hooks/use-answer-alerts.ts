import { useCallback, useEffect, useRef, useState } from 'react';
import type { CommentThread } from '../components/comments/types';
import {
  addAlerts,
  answeredThreads,
  dropSeenAlerts,
  toAlert,
  type AnswerAlert,
} from '../lib/answer-alerts';

function tabHidden(): boolean {
  return document.visibilityState === 'hidden';
}

/**
 * Answers to the reader's questions that landed somewhere they are not looking. `threads` is
 * undefined until the first load, which is the baseline every later poll is compared with.
 */
export function useAnswerAlerts(
  threads: CommentThread[] | undefined,
  isOnScreen: (threadId: string) => boolean,
) {
  const previous = useRef<CommentThread[] | null>(null);
  const [alerts, setAlerts] = useState<AnswerAlert[]>([]);

  useEffect(() => {
    if (!threads) {
      return;
    }
    const answered = answeredThreads(previous.current, threads);
    previous.current = threads;

    const hidden = tabHidden();
    const fresh = answered
      .filter(thread => hidden || !isOnScreen(thread.id))
      .map(thread => toAlert(thread, hidden));
    if (fresh.length > 0) {
      setAlerts(prev => addAlerts(prev, fresh));
    }
  }, [threads, isOnScreen]);

  const pending = alerts.length > 0;
  useEffect(() => {
    if (!pending) {
      return;
    }

    let frame = 0;
    const check = () => {
      frame = 0;
      if (!tabHidden()) {
        setAlerts(prev => dropSeenAlerts(prev, isOnScreen));
      }
    };
    const schedule = () => {
      frame ||= requestAnimationFrame(check);
    };

    document.addEventListener('scroll', schedule, { capture: true, passive: true });
    document.addEventListener('visibilitychange', schedule);
    return () => {
      document.removeEventListener('scroll', schedule, { capture: true });
      document.removeEventListener('visibilitychange', schedule);
      if (frame) {
        cancelAnimationFrame(frame);
      }
    };
  }, [pending, isOnScreen]);

  const clear = useCallback((threadId: string) => {
    setAlerts(prev => prev.filter(alert => alert.threadId !== threadId));
  }, []);

  const dismiss = useCallback(() => setAlerts([]), []);

  return {
    alerts,
    unseenWhileHidden: alerts.filter(alert => alert.whileHidden).length,
    clear,
    dismiss,
  };
}
