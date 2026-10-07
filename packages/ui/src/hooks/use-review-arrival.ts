import { useCallback, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { ReviewState } from '../lib/api';

export const ARRIVAL_QUERY_KEYS = [['diff'], ['threads'], ['tours'], ['repo-info']];

export function isReviewPending(state: ReviewState | undefined): boolean {
  return state === 'queued' || state === 'reviewing';
}

/**
 * Follows a review that is under way while the page is open. Once it is done the reader takes it
 * in with `reload`, rather than having the file list reorder underneath them.
 */
export function useReviewArrival(state: ReviewState) {
  const queryClient = useQueryClient();
  const pending = isReviewPending(state);
  const [watching, setWatching] = useState(pending);
  if (pending && !watching) {
    setWatching(true);
  }

  const reload = useCallback(() => {
    setWatching(false);
    for (const queryKey of ARRIVAL_QUERY_KEYS) {
      void queryClient.invalidateQueries({ queryKey });
    }
  }, [queryClient]);

  return { watching: watching || pending, ready: watching && state === 'done', reload };
}

/** The value as it was when `hold` began, until it ends. */
export function useHeld<T>(value: T, hold: boolean): T {
  const held = useRef(value);
  if (!hold) {
    held.current = value;
  }
  return held.current;
}
